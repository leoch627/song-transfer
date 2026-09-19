import { aiStatus, reviewWithAi } from "@/lib/ai";
import { getEncryptedCookie, Session, SESSION_COOKIE } from "@/lib/auth";
import {
  AppError,
  errorResponse,
  readBody,
  requireSameOrigin,
} from "@/lib/http";
import type { Candidate, Song } from "@/lib/types";
export const maxDuration = 90;
function validSong(value: unknown): value is Song {
  if (!value || typeof value !== "object") return false;
  const song = value as Song;
  return (
    typeof song.id === "string" &&
    song.id.length <= 100 &&
    typeof song.name === "string" &&
    song.name.length <= 500 &&
    typeof song.album === "string" &&
    song.album.length <= 500 &&
    Array.isArray(song.artists) &&
    song.artists.length <= 30 &&
    song.artists.every((a) => typeof a === "string" && a.length <= 200) &&
    Number.isFinite(song.durationMs) &&
    song.durationMs >= 0
  );
}
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    if (!aiStatus().configured) throw new AppError("请先配置 AI 中转站。", 503);
    const session = await getEncryptedCookie<Session>(SESSION_COOKIE);
    if (!session || (session.expiresAt <= Date.now() && !session.refreshToken))
      throw new AppError("请先连接 Spotify，再使用 AI 复核。", 401);
    const data = await readBody(request);
    if (
      !validSong(data.source) ||
      !Array.isArray(data.candidates) ||
      !data.candidates.length ||
      data.candidates.length > 5 ||
      !data.candidates.every(validSong)
    )
      throw new AppError("请提供原曲及最多 5 个有效的候选歌曲。");
    const review = await reviewWithAi(
      data.source,
      data.candidates as Candidate[],
    );
    return Response.json(review, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
