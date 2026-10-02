import { getAccessToken } from "@/lib/auth";
import {
  AppError,
  errorResponse,
  readBody,
  requireSameOrigin,
} from "@/lib/http";
import { transferPlaylist } from "@/lib/spotify";
import { taskOwner } from "@/lib/task-owner";
import { taskStore } from "@/lib/task-store";
export const maxDuration = 300;
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const body = await readBody(request);
    if (typeof body.taskId !== "string")
      throw new AppError("请先创建后台任务并完成匹配。", 409);
    const token = await getAccessToken();
    const owner = (await taskOwner(true))!,
      store = taskStore();
    const input = store.beginTransfer(body.taskId, owner);
    try {
      const result = await transferPlaylist(
        token,
        input.name,
        input.uris,
        input.isPublic,
      );
      store.finishTransfer(body.taskId, owner, result);
      return Response.json(result, {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      if (error instanceof AppError && [401, 403, 429].includes(error.status))
        store.finishTransfer(body.taskId, owner, null, true);
      throw error;
    }
  } catch (error) {
    return errorResponse(error);
  }
}
