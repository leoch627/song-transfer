import {
  AppError,
  errorResponse,
  readBody,
  requireSameOrigin,
} from "@/lib/http";
import { getQqPlaylist } from "@/lib/qq";

export const maxDuration = 300;
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const body = await readBody(request);
    if (typeof body.input !== "string" || body.input.length > 2000)
      throw new AppError("请输入有效的 QQ 歌单链接或 ID。");
    return Response.json(await getQqPlaylist(body.input), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
