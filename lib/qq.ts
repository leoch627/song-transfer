import { AppError, retryAfterSeconds } from "./http";
import { parseQqPlaylistId, qqShortShareUrl } from "./playlist-source";
import type { Playlist, Song } from "./types";

const PAGE_SIZE = 100;
const MAX_SONGS = 10000;
type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";
const count = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
function coverUrl(value: unknown) {
  const url = text(value).replace(/^http:/, "https:");
  return url.startsWith("https://") ? url : undefined;
}

async function resolveId(input: string, signal: AbortSignal): Promise<string> {
  const id = parseQqPlaylistId(input);
  if (id) return id;
  let url = qqShortShareUrl(input);
  for (let hop = 0; url && hop < 5; hop++) {
    const response = await fetch(url, {
      redirect: "manual",
      cache: "no-store",
      signal,
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://y.qq.com/" },
    });
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (![301, 302, 303, 307, 308].includes(response.status) || !location)
      break;
    const next = new URL(location, url);
    const nextId = parseQqPlaylistId(next.href);
    if (nextId) return nextId;
    // Only known QQ short links may be fetched; never follow arbitrary redirects.
    url = qqShortShareUrl(next.href);
  }
  throw new AppError(
    "请输入 QQ 音乐公开歌单链接或数字 ID。短链接若无法读取，请在浏览器打开后复制完整歌单地址。",
  );
}

function toSong(value: unknown): Song | null {
  const raw = object(value),
    album = object(raw.album);
  const mid = text(raw.mid);
  const id = count(raw.id) || (/^[a-zA-Z0-9]+$/.test(mid) ? mid : "");
  const name = text(raw.name) || text(raw.title);
  if (!id || !name) return null;
  const albumMid = text(album.mid);
  return {
    id: `qq:${id}`,
    name,
    artists: Array.isArray(raw.singer)
      ? raw.singer.map((s) => text(object(s).name)).filter(Boolean)
      : [],
    album: text(album.name) || text(album.title),
    durationMs: count(raw.interval) * 1000,
    cover: /^[a-zA-Z0-9]+$/.test(albumMid)
      ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg`
      : undefined,
  };
}

async function fetchPage(id: string, offset: number, signal: AbortSignal) {
  const response = await fetch("https://u.y.qq.com/cgi-bin/musicu.fcg", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Referer: "https://y.qq.com/",
      "User-Agent": "Mozilla/5.0",
    },
    cache: "no-store",
    signal: AbortSignal.any([signal, AbortSignal.timeout(25000)]),
    body: JSON.stringify({
      comm: {
        ct: 24,
        cv: 4747474,
        platform: "yqq.json",
        uin: "0",
        g_tk: 5381,
        g_tk_new_20200303: 5381,
        format: "json",
        inCharset: "utf-8",
        outCharset: "utf-8",
        notice: 0,
        need_new_code: 1,
      },
      playlist: {
        module: "music.srfDissInfo.DissInfo",
        method: "CgiGetDiss",
        param: {
          disstid: Number(id),
          dirid: 0,
          tag: true,
          song_begin: offset,
          song_num: PAGE_SIZE,
          userinfo: true,
          orderlist: true,
          onlysonglist: false,
        },
      },
    }),
  });
  if (response.status === 429)
    throw new AppError(
      "QQ 音乐暂时限制读取，请稍后重试。",
      429,
      retryAfterSeconds(response.headers.get("retry-after")),
    );
  if (!response.ok)
    throw new AppError("QQ 音乐暂时无法响应，请稍后重试。", 502);
  const json = object(await response.json()),
    block = object(json.playlist),
    data = object(block.data);
  if (
    json.code !== 0 ||
    block.code !== 0 ||
    (data.code !== undefined && data.code !== 0)
  )
    throw new AppError(
      "无法读取 QQ 歌单，请确认链接有效且歌单已公开。私密歌单和未公开的「我喜欢」暂不支持。",
      422,
    );
  if (!Array.isArray(data.songlist))
    throw new AppError("QQ 音乐返回的歌曲列表不完整，请稍后重试。", 502);
  return { data, detail: object(data.dirinfo), tracks: data.songlist };
}

export async function getQqPlaylist(input: string): Promise<Playlist> {
  const signal = AbortSignal.timeout(240000);
  const id = await resolveId(
    input,
    AbortSignal.any([signal, AbortSignal.timeout(25000)]),
  );
  const songs = new Map<string, Song>(),
    pages = new Set<string>();
  let detail: Json = {},
    total = 0,
    offset = 0;
  for (let page = 0; page < MAX_SONGS / PAGE_SIZE; page++) {
    const result = await fetchPage(id, offset, signal);
    if (page === 0) {
      detail = result.detail;
      if (
        !text(detail.title) ||
        (detail.id !== undefined && String(detail.id) !== id)
      )
        throw new AppError(
          "无法读取这个 QQ 歌单，请确认歌单存在且已公开。",
          422,
        );
    }
    total = Math.max(
      total,
      count(result.data.total_song_num),
      count(result.detail.songnum),
    );
    if (total > MAX_SONGS || offset + result.tracks.length > MAX_SONGS)
      throw new AppError("单次最多读取 10,000 首，请拆分歌单后重试。", 422);
    if (!result.tracks.length) break;
    const fingerprint = JSON.stringify(
      result.tracks.map((v) => object(v).id || object(v).mid || null),
    );
    if (pages.has(fingerprint))
      throw new AppError(
        "QQ 歌单分页重复，请稍后重新读取，避免遗漏歌曲。",
        502,
      );
    pages.add(fingerprint);
    for (const track of result.tracks) {
      const song = toSong(track);
      if (song && !songs.has(song.id)) songs.set(song.id, song);
    }
    offset += result.tracks.length;
    const marker = result.data.hasmore;
    const more =
      marker === undefined
        ? total
          ? offset < total
          : result.tracks.length === PAGE_SIZE
        : marker === true || Number(marker) > 0;
    if (!more) break;
    if (page === MAX_SONGS / PAGE_SIZE - 1)
      throw new AppError("QQ 歌单分页过多，请拆分歌单后重试。", 422);
  }
  total = Math.max(total, offset, songs.size);
  return {
    provider: "qq",
    id,
    name: text(detail.title),
    creator:
      text(detail.host_nick) ||
      text(object(detail.creator).nick) ||
      "QQ 音乐用户",
    cover: coverUrl(detail.picurl) || coverUrl(detail.picurl2),
    total,
    songs: [...songs.values()],
    missing: total - songs.size,
  };
}
