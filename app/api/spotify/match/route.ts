import { getAccessToken } from "@/lib/auth";
import {
  AppError,
  errorResponse,
  readBody,
  requireSameOrigin,
} from "@/lib/http";
import { searchTrack } from "@/lib/spotify";
export const maxDuration = 90;
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const body = await readBody(request);
    const song = body.song as Record<string, unknown> | undefined;
    if (
      !song ||
      typeof song.name !== "string" ||
      !song.name.trim() ||
      song.name.length > 500 ||
      !Array.isArray(song.artists) ||
      song.artists.length > 30 ||
      !song.artists.every((a) => typeof a === "string" && a.length <= 200) ||
      typeof song.id !== "string" ||
      typeof song.album !== "string" ||
      song.album.length > 500 ||
      typeof song.durationMs !== "number" ||
      !Number.isFinite(song.durationMs) ||
      song.durationMs < 0
    )
      throw new AppError("歌曲信息不完整。");
    const token = await getAccessToken();
    const match = await searchTrack(token, {
      id: song.id,
      name: song.name,
      artists: song.artists as string[],
      album: song.album,
      durationMs: song.durationMs,
    });
    return Response.json(match, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
