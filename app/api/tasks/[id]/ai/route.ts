import { aiStatus } from "@/lib/ai";
import { AiTaskQueue } from "@/lib/ai-task-queue";
import { getAccessToken } from "@/lib/auth";
import {
  AppError,
  errorResponse,
  readBody,
  requireSameOrigin,
} from "@/lib/http";
import { taskOwner } from "@/lib/task-owner";
import { taskStore } from "@/lib/task-store";

export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    requireSameOrigin(request);
    const owner = (await taskOwner(true))!,
      id = (await context.params).id;
    const data = await readBody(request);
    const store = taskStore(),
      queue = new AiTaskQueue(store);
    if (data.action === "pause") queue.pause(id, owner);
    else if (data.action === "start" || data.action === "unmatched" || data.action === "all") {
      // Old browser tabs may still send "all". Always narrow that request on the server.
      const unmatched = data.action === "unmatched" || data.action === "all";
      if (!aiStatus().configured)
        throw new AppError("请先配置 AI 中转站。", 503);
      if (unmatched && !aiStatus().webSearch)
        throw new AppError("查原唱需要开启联网核实。", 503);
      await getAccessToken();
      if (
        data.indices !== undefined &&
        (!Array.isArray(data.indices) ||
          data.indices.length > 10000 ||
          !data.indices.every(Number.isInteger))
      )
        throw new AppError("复核歌曲列表无效。");
      queue.start(
        id,
        owner,
        data.indices as number[] | undefined,
        data.webSearch === true,
        unmatched,
      );
    } else throw new AppError("未知复核操作。");
    return Response.json(
      { task: store.get(id, owner), quota: store.quota() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
