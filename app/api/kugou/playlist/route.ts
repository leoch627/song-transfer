import { AppError, errorResponse, readBody, requireSameOrigin } from "@/lib/http";
import { getKugouPlaylist } from "@/lib/kugou";

export const maxDuration = 300;
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const body = await readBody(request);
    if (typeof body.input !== "string" || body.input.length > 2000)
      throw new AppError("请输入有效的酷狗歌单链接或 ID。");
    return Response.json(await getKugouPlaylist(body.input), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) { return errorResponse(error); }
}
