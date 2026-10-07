import { createHash } from "node:crypto";
import { AppError } from "./http";
import { spotifyRequest } from "./spotify";
import { taskAccessToken } from "./task-session";
import { taskStore, type TaskStore } from "./task-store";
import { TransferQueue, type TransferClaim } from "./transfer-queue";

type PlaylistInfo = {
  id: string;
  description?: string | null;
  owner: { id: string };
  snapshot_id: string;
  items?: { total: number };
  tracks?: { total: number };
};
type TrackInfo = { uri: string; linked_from?: { uri: string } };
type Page<T> = {
  items: T[];
  total: number;
  offset: number;
  next: string | null;
};
const playlistSize = (p: PlaylistInfo) => p.items?.total ?? p.tracks?.total;
function block(message: string): never {
  throw new AppError(message, 409, undefined, "VERIFY_REQUIRED");
}

// Each step performs at most one mutation or one page of verification. A pending
// operation is committed to SQLite BEFORE the network write, including on restart.
export async function runTransferStep(
  store: TaskStore = taskStore(),
  dependencies?: {
    token: (owner: string) => Promise<string>;
    request?: typeof spotifyRequest;
  },
) {
  const queue = new TransferQueue(store),
    claim = queue.claim();
  if (!claim) return false;
  const s = claim.state;
  let writing = false;
  const request = dependencies?.request || spotifyRequest;
  try {
    const token = await (
      dependencies?.token || ((owner) => taskAccessToken(owner, store))
    )(claim.owner);
    // A reconnect to a different Spotify account must not redirect a queued job.
    const hash = createHash("sha256").update(token).digest("hex");
    const read = async <T>(endpoint: string) => {
      queue.check(claim);
      return request<T>(token, endpoint);
    };
    if (hash !== s.tokenHash) {
      const me = await read<{ id: string }>("/me");
      if (!me.id)
        throw new AppError("无法确认 Spotify 账号，请重新连接。", 401);
      if (s.spotifyUser && me.id !== s.spotifyUser)
        throw new AppError(
          "Spotify 账号已切换，请重新连接创建本任务歌单的账号后继续。",
          401,
        );
      s.spotifyUser = me.id;
      s.tokenHash = hash;
      queue.save(claim, "queued");
      return true;
    }
    // Snapshot IDs returned by write endpoints are not comparable with the one
    // GET /playlists returns for the same state (observed in production: the
    // create response and an immediate GET differ). After each acknowledged
    // write, persist the progress, then record the live GET snapshot so the
    // pre-batch check below compares GET with GET and still detects edits.
    const adoptLiveSnapshot = async (status: "queued" | "complete") => {
      s.snapshot = "";
      queue.save(claim);
      if (status === "queued") {
        const live = await metadata();
        if (playlistSize(live) === s.added) s.snapshot = live.snapshot_id;
      }
      queue.save(claim, status);
    };
    const metadata = async (id = s.playlistId) => {
      const p = await read<PlaylistInfo>(
        `/playlists/${id}?fields=id,owner(id),snapshot_id,items(total),tracks(total)`,
      );
      if (
        p.id !== id ||
        p.owner?.id !== s.spotifyUser ||
        !p.snapshot_id ||
        !Number.isInteger(playlistSize(p))
      )
        block(
          "无法核对目标歌单的归属或歌曲数量，已暂停写入。请检查 Spotify 歌单后重新核实。",
        );
      return p;
    };
    if (s.pending === "create") {
      await recoverCreation(claim, read, metadata);
      queue.save(claim, "queued");
      return true;
    }
    if (s.pending === "append") {
      const expected = Math.min(s.added + 100, s.uris.length);
      if (!s.verification) {
        const p = await metadata();
        if (playlistSize(p) !== expected)
          block(
            `最后一批写入尚未确认：Spotify 当前有 ${playlistSize(p)} 首，已确认写入 ${s.added} 首。为避免重复添加，已暂停；可稍后重新核实。`,
          );
        s.verification = {
          offset: 0,
          total: expected,
          snapshot: p.snapshot_id,
        };
      } else if (s.verification.offset < expected) {
        const v = s.verification;
        const page = await read<
          Page<{
            item?: TrackInfo | null;
            track?: TrackInfo | null;
            is_local?: boolean;
          }>
        >(`/playlists/${s.playlistId}/items?limit=50&offset=${v.offset}`);
        if (
          page.offset !== v.offset ||
          page.total !== expected ||
          !page.items.length ||
          page.items.length > expected - v.offset
        )
          block(
            "Spotify 歌单分页或数量发生变化，已暂停自动写入。请检查后重新核实。",
          );
        for (const [index, entry] of page.items.entries()) {
          const track = entry.item ?? entry.track,
            uri = s.uris[v.offset + index];
          if (
            entry.is_local ||
            !track ||
            (track.uri !== uri && track.linked_from?.uri !== uri)
          )
            block(
              "Spotify 歌曲或顺序与本次迁移不一致，已暂停自动写入，避免重复或误加。请检查目标歌单。",
            );
        }
        v.offset += page.items.length;
      } else {
        const p = await metadata();
        if (
          p.snapshot_id !== s.verification.snapshot ||
          playlistSize(p) !== expected
        )
          block("核实期间 Spotify 歌单发生变化，请检查后重新核实。");
        s.added = expected;
        s.snapshot = p.snapshot_id;
        s.pending = "";
        s.verification = null;
      }
      queue.save(claim, s.added === s.uris.length ? "complete" : "queued");
      return true;
    }
    if (!s.playlistId) {
      s.pending = "create";
      queue.save(claim);
      queue.check(claim);
      writing = true;
      const p = await request<PlaylistInfo>(token, "/me/playlists", {
        method: "POST",
        body: JSON.stringify({
          name: s.name,
          public: s.isPublic,
          description: s.marker,
        }),
      });
      if (!/^[A-Za-z0-9]{22}$/.test(p.id))
        throw new Error("Missing playlist ID");
      s.playlistId = p.id;
      s.pending = "";
      writing = false;
      await adoptLiveSnapshot("queued");
      return true;
    }
    // Detect external edits between batches before appending any more tracks.
    const p = await metadata();
    if (
      playlistSize(p) !== s.added ||
      (s.snapshot && p.snapshot_id !== s.snapshot)
    )
      block("目标歌单在迁移期间被修改，已暂停后台写入。请检查后重新核实。");
    s.snapshot = p.snapshot_id;
    s.pending = "append";
    queue.save(claim);
    queue.check(claim);
    writing = true;
    const batch = s.uris.slice(s.added, s.added + 100);
    const response = await request<{ snapshot_id: string }>(
      token,
      `/playlists/${s.playlistId}/items`,
      {
        method: "POST",
        body: JSON.stringify({ uris: batch }),
      },
    );
    if (!response.snapshot_id) throw new Error("Missing playlist snapshot");
    s.added += batch.length;
    s.pending = "";
    writing = false;
    await adoptLiveSnapshot(s.added === s.uris.length ? "complete" : "queued");
  } catch (error) {
    if (error instanceof AppError && error.reason === "LEASE_LOST") return true;
    // These responses explicitly reject the mutation. Timeouts and 5xx do not.
    const rejected =
      error instanceof AppError && [401, 403, 429].includes(error.status);
    if (writing && rejected) s.pending = "";
    if (error instanceof AppError && error.status === 429) {
      // Only the write wait: a write 429 must not stall matching/search, and a
      // search 429 never blocks writes (see TransferQueue.initialize).
      queue.cooldown(error.retryAfter || 60, error.reason || "RATE_LIMITED");
      queue.save(
        claim,
        "waiting",
        "Spotify 暂时限流，进度已保存，到时自动继续。",
        queue.resumeAt(),
      );
    } else if (error instanceof AppError && error.status === 401) {
      queue.save(claim, "needs_auth", error.message);
    } else if (
      error instanceof AppError &&
      error.reason === "VERIFY_REQUIRED"
    ) {
      queue.save(claim, "blocked", error.message);
    } else if (error instanceof AppError && error.status === 403) {
      queue.save(
        claim,
        "failed",
        `${error.message} 若此前已授权，请重新连接 Spotify，授予读取私密歌单权限后继续。`,
      );
    } else {
      queue.save(
        claim,
        "waiting",
        s.pending
          ? "连接中断，稍后自动核实最后一次写入；不会直接重复提交。"
          : "Spotify 暂时无法连接，已保存进度，稍后自动继续。",
        store.now() + 60000,
      );
    }
  }
  return true;
}

async function recoverCreation(
  claim: TransferClaim,
  read: <T>(endpoint: string) => Promise<T>,
  metadata: (id?: string) => Promise<PlaylistInfo>,
) {
  const s = claim.state;
  if (s.scanOffset >= 0) {
    const page = await read<Page<PlaylistInfo | null>>(
      `/me/playlists?limit=50&offset=${s.scanOffset}`,
    );
    if (page.offset !== s.scanOffset || !Array.isArray(page.items))
      block("无法核对已创建的 Spotify 歌单，请稍后重新核实。");
    for (const p of page.items) {
      if (p?.description !== s.marker || p.owner?.id !== s.spotifyUser)
        continue;
      if (!/^[A-Za-z0-9]{22}$/.test(p.id) || (s.foundId && s.foundId !== p.id))
        block("发现多个迁移标记相同的歌单，请检查 Spotify；没有再次创建歌单。");
      s.foundId = p.id;
    }
    if (page.next) {
      if (!page.items.length || s.scanOffset >= 11000)
        block("Spotify 歌单列表未能完整读取，请稍后重新核实。");
      s.scanOffset += page.items.length;
    } else {
      s.scanOffset = -1;
      if (!s.foundId)
        block(
          "创建请求的结果仍未确认，暂未找到本次迁移标记的歌单。可稍后重新核实；没有重复创建歌单。",
        );
    }
    return;
  }
  const p = await metadata(s.foundId);
  if (playlistSize(p) !== 0)
    block("已找到本次创建的歌单，但内容已被修改。请检查 Spotify 后重新核实。");
  s.playlistId = p.id;
  s.snapshot = p.snapshot_id;
  s.pending = "";
}
