import { getAccessToken } from "@/lib/auth";
import {
  AppError,
  errorResponse,
  readBody,
  requireSameOrigin,
} from "@/lib/http";
import { transferPlaylist } from "@/lib/spotify";
export const maxDuration = 300;
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const body = await readBody(request);
    if (
      typeof body.name !== "string" ||
      !body.name.trim() ||
      body.name.length > 100 ||
      typeof body.isPublic !== "boolean" ||
      !Array.isArray(body.uris) ||
      !body.uris.length ||
      body.uris.length > 10000 ||
      !body.uris.every(
        (uri) =>
          typeof uri === "string" &&
          /^spotify:track:[a-zA-Z0-9]{22}$/.test(uri),
      )
    )
      throw new AppError("请填写歌单名称并选择有效的匹配歌曲。");
    const token = await getAccessToken();
    return Response.json(
      await transferPlaylist(
        token,
        body.name.trim(),
        body.uris as string[],
        body.isPublic,
      ),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
