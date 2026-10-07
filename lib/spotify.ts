import { AppError, retryAfterSeconds } from "./http";
import { makeMatch, scoreCandidate } from "./matching";
import type { Candidate, Song } from "./types";

export async function spotifyRequest<T>(
  token: string,
  endpoint: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`https://api.spotify.com/v1${endpoint}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(25000),
  });
  if (response.status === 429) {
    const body = await response.json().catch(() => null);
    const quota = body?.error?.reason === "QUOTA_EXCEEDED";
    const seconds = retryAfterSeconds(response.headers.get("retry-after"));
    throw new AppError(
      `Spotify 请求额度暂时用完，请至少等待 ${seconds} 秒后继续。`,
      429,
      seconds,
      quota ? "QUOTA_EXCEEDED" : "RATE_LIMITED",
    );
  }
  if (response.status === 401)
    throw new AppError("Spotify 授权已失效，请重新连接。", 401);
  if (response.status === 403)
    throw new AppError(
      "Spotify 拒绝了请求，请检查应用允许的用户、Premium 要求和授权权限。",
      403,
    );
  if (!response.ok)
    throw new AppError(
      `Spotify 请求失败（${response.status}），请稍后重试。`,
      502,
    );
  return response.status === 204 ? (undefined as T) : response.json();
}
type SpotifyTrack = {
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  is_playable?: boolean;
  artists: { name: string }[];
  album: { name: string; images?: { url: string }[] };
  external_urls: { spotify: string };
};
export type SearchCheckpoint = { nextQuery: number; candidates: Candidate[] };
export type SearchOptions = {
  checkpoint?: SearchCheckpoint;
  beforeRequest?: () => void;
  onProgress?: (checkpoint: SearchCheckpoint) => void;
};
export async function searchTrack(
  token: string,
  song: Song,
  options: SearchOptions = {},
) {
  const name = song.name.replaceAll('"', " ");
  const artist = (song.artists[0] || "").replaceAll('"', " ");
  const queries = [
    ...new Set([
      `track:"${name}"${artist ? ` artist:"${artist}"` : ""}`,
      `${name} ${artist}`.trim(),
      name,
    ]),
  ];
  const candidates = new Map<string, Candidate>(
    (options.checkpoint?.candidates || []).map((candidate) => [
      candidate.id,
      candidate,
    ]),
  );
  for (
    let index = options.checkpoint?.nextQuery || 0;
    index < queries.length;
    index++
  ) {
    if ([...candidates.values()].some((candidate) => candidate.confident))
      break;
    const query = queries[index];
    options.beforeRequest?.();
    for (const candidate of await searchCandidates(token, song, query)) {
      if (!candidates.has(candidate.id))
        candidates.set(candidate.id, candidate);
    }
    options.onProgress?.({
      nextQuery: index + 1,
      candidates: [...candidates.values()],
    });
    if ([...candidates.values()].some((candidate) => candidate.confident))
      break;
  }
  const match = makeMatch(song, [...candidates.values()]);
  return { ...match, candidates: match.candidates.slice(0, 5) };
}

export async function searchCandidates(
  token: string,
  source: Song,
  query: string,
): Promise<Candidate[]> {
  const params = new URLSearchParams({ q: query, type: "track", limit: "10" });
  const data = await spotifyRequest<{
    tracks?: { items: (SpotifyTrack | null)[] };
  }>(token, `/search?${params}`);
  return (data.tracks?.items || []).flatMap((item) => {
    if (
      !item ||
      !/^[A-Za-z0-9]{22}$/.test(item.id) ||
      item.is_playable === false
    )
      return [];
    return [
      scoreCandidate(source, {
        id: item.id,
        name: item.name,
        artists: item.artists.map((a) => a.name),
        album: item.album.name,
        durationMs: item.duration_ms,
        cover: item.album.images?.at(-1)?.url,
        uri: `spotify:track:${item.id}`,
        url: `https://open.spotify.com/track/${item.id}`,
      }),
    ];
  });
}

export type TransferResult = {
  id: string;
  url: string;
  added: number;
  total: number;
  complete: boolean;
  error?: string;
};
export async function transferPlaylist(
  token: string,
  name: string,
  uris: string[],
  isPublic: boolean,
): Promise<TransferResult> {
  // Writes are deliberately not retried: a network timeout can occur after Spotify committed a write.
  const playlist = await spotifyRequest<{
    id: string;
    external_urls: { spotify: string };
  }>(token, "/me/playlists", {
    method: "POST",
    body: JSON.stringify({
      name,
      public: isPublic,
      description: "Imported from NetEase Cloud Music with SongTransfer 移调",
    }),
  });
  const result: TransferResult = {
    id: playlist.id,
    url: playlist.external_urls.spotify,
    added: 0,
    total: uris.length,
    complete: false,
  };
  try {
    for (let offset = 0; offset < uris.length; offset += 100) {
      const batch = uris.slice(offset, offset + 100);
      await spotifyRequest(token, `/playlists/${playlist.id}/items`, {
        method: "POST",
        body: JSON.stringify({ uris: batch }),
      });
      result.added += batch.length;
    }
    result.complete = true;
  } catch (error) {
    result.error =
      (error instanceof AppError
        ? error.message
        : "连接中断，最后一批写入结果待确认。") +
      " 请先打开 Spotify 检查已创建的歌单，以免重复导入。";
  }
  return result;
}
