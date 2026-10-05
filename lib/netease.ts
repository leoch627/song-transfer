import { AppError } from "./http";
import { parsePlaylistId } from "./matching";
import type { Playlist, Song } from "./types";

type RawSong = {
  id: number;
  name: string;
  ar?: { name: string }[];
  artists?: { name: string }[];
  al?: { name: string; picUrl?: string };
  album?: { name: string; picUrl?: string };
  dt?: number;
  duration?: number;
};
async function netease(path: string, params: Record<string, string>) {
  const url = new URL(path, "https://music.163.com");
  url.search = new URLSearchParams(params).toString();
  const response = await fetch(url, {
    headers: { Referer: "https://music.163.com/", "User-Agent": "Mozilla/5.0" },
    cache: "no-store",
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) throw new AppError("网易云暂时无法响应，请稍后重试。", 502);
  const data = await response.json();
  if (data.code !== undefined && data.code !== 200)
    throw new AppError("无法读取歌单，请确认歌单公开且链接有效。", 422);
  return data;
}
function toSong(raw: RawSong): Song {
  return {
    id: String(raw.id),
    name: raw.name,
    artists: (raw.ar || raw.artists || []).map((a) => a.name),
    album: (raw.al || raw.album)?.name || "",
    durationMs: raw.dt || raw.duration || 0,
    cover: (raw.al || raw.album)?.picUrl?.replace(/^http:/, "https:"),
  };
}
export async function getPlaylist(input: string): Promise<Playlist> {
  const id = parsePlaylistId(input);
  if (!id)
    throw new AppError(
      "请输入网易云歌单链接或数字 ID，短链接请先在浏览器中展开。",
    );
  const data = await netease("/api/v6/playlist/detail", {
    id,
    n: "100000",
    s: "0",
  });
  const playlist = data.playlist;
  if (!playlist || playlist.privacy === 10)
    throw new AppError("无法读取这个歌单，请确认歌单存在且已公开。", 422);
  const ids: number[] = (playlist.trackIds || []).map(
    (track: { id: number }) => track.id,
  );
  if (ids.length > 10000)
    throw new AppError("单次最多读取 10,000 首，请拆分歌单后重试。", 422);
  const songs = new Map<string, Song>();
  for (const track of (playlist.tracks || []) as RawSong[])
    songs.set(String(track.id), toSong(track));
  const missingIds = ids.filter((track) => !songs.has(String(track)));
  for (let start = 0; start < missingIds.length; start += 200) {
    const batch = missingIds.slice(start, start + 200);
    const details = await netease("/api/song/detail/", {
      ids: JSON.stringify(batch),
    });
    for (const track of (details.songs || []) as RawSong[])
      songs.set(String(track.id), toSong(track));
  }
  const ordered = ids.length
    ? ids
        .map((track) => songs.get(String(track)))
        .filter((song): song is Song => !!song)
    : [...songs.values()];
  const total = Math.max(playlist.trackCount || 0, ids.length, ordered.length);
  return {
    provider: "netease",
    id,
    name: playlist.name,
    creator: playlist.creator?.nickname || "网易云用户",
    cover: playlist.coverImgUrl?.replace(/^http:/, "https:"),
    total,
    songs: ordered,
    missing: total - ordered.length,
  };
}
