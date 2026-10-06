import {
  AppError,
  errorResponse,
  readBody,
  requireSameOrigin,
} from "@/lib/http";
import { taskOwner } from "@/lib/task-owner";
import { taskStore } from "@/lib/task-store";
import { TransferQueue } from "@/lib/transfer-queue";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const body = await readBody(request);
    if (typeof body.taskId !== "string")
      throw new AppError("请先创建后台任务并完成匹配。", 409);
    if (body.action !== undefined && body.action !== "retry")
      throw new AppError("未知写入操作。");
    const owner = (await taskOwner(true))!,
      store = taskStore();
    store.owned(body.taskId, owner);
    const account = store.account(owner);
    if (!account) throw new AppError("请先连接 Spotify 账号。", 401);
    if (!account.scope?.split(" ").includes("playlist-read-private"))
      throw new AppError(
        "请重新连接 Spotify，授予读取私密歌单权限，以便后台核对写入进度。原任务和匹配结果会保留。",
        403,
      );
    const queue = new TransferQueue(store);
    if (body.action === "retry") queue.retry(body.taskId, owner);
    else queue.enqueue(body.taskId, owner);
    return Response.json(
      { task: store.get(body.taskId, owner), quota: store.quota() },
      {
        status: 202,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
