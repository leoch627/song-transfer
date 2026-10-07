import { makeMatch, scoreCandidate } from "./matching";
import type { Match, Playlist, Song } from "./types";

const records = [
  ["晴天", "周杰伦", "叶惠美", 269000],
  ["落日飞车", "落日飞车", "BOSSA NOVA", 242000],
  ["有何不可", "许嵩", "自定义", 241000],
  ["City of Stars", "Ryan Gosling / Emma Stone", "La La Land", 149000],
  ["想去海边", "夏日入侵企画", "想去海边", 272000],
  ["Mystery of Love", "Sufjan Stevens", "Call Me by Your Name", 248000],
  ["晚风", "陈婧霏", "陈婧霏", 227000],
  ["某个夏天的未发行 Demo", "独立音乐人", "私人收藏", 188000],
] as const;

export const demoPlaylist: Playlist = {
  id: "demo",
  name: "把日子调成喜欢的频道",
  creator: "SongTransfer 示例歌单",
  total: records.length,
  missing: 0,
  songs: records.map(([name, artist, album, durationMs], index) => ({
    id: `demo-${index}`,
    name,
    artists: artist.split(" / "),
    album,
    durationMs,
  })),
};
export function demoMatch(song: Song, index: number): Match {
  if (index === 7) return makeMatch(song, []);
  const candidate = scoreCandidate(song, {
    ...song,
    id: `example-${index}`,
    name: index === 1 ? `${song.name} (Live)` : song.name,
    durationMs: song.durationMs + (index === 1 ? 28000 : 0),
    uri: `demo:track:${index}`,
    url: "",
  });
  return makeMatch(song, [candidate]);
}
