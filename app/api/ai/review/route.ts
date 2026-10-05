import { aiStatus } from "@/lib/ai";
import { reviewSong } from "@/lib/ai-review-service";
import { taskOwner } from "@/lib/task-owner";
import { taskStore } from "@/lib/task-store";
import { getAccessToken } from "@/lib/auth";
import {
  AppError,
  errorResponse,
  readBody,
  requireSameOrigin,
} from "@/lib/http";
import type { Candidate, Song } from "@/lib/types";
export const runtime = "nodejs";
export const maxDuration = 300;
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
    const token = await getAccessToken();
    const data = await readBody(request);
    if (
      !validSong(data.source) ||
      !Array.isArray(data.candidates) ||
      data.candidates.length > 5 ||
      !data.candidates.every(validSong)
    )
      throw new AppError("请提供原曲及最多 5 个有效的候选歌曲。");
    const store = taskStore();
    const owner = (await taskOwner(true))!;
    const taskId = typeof data.taskId === "string" ? data.taskId : null;
    const task = taskId ? store.get(taskId, owner) : null;
    if (
      task?.aiJob &&
      (["queued", "running", "waiting"].includes(task.aiJob.status) ||
        task.aiJob.current.length)
    )
      throw new AppError(
        "此任务已在后台复核，请刷新页面查看进度，避免重复处理。",
        409,
      );
    const index =
      task?.matches.findIndex(
        (m) => m.source.id === (data.source as Song).id,
      ) ?? -1;
    if (
      task &&
      (index < 0 ||
        task.workspace.writeStarted ||
        task.matches[index].status === "pending")
    )
      throw new AppError("歌曲尚未匹配或任务已开始迁移，不能复核。", 409);
    const original = task?.matches[index];
    const result = await reviewSong(
      original?.source || data.source,
      original?.candidates || (data.candidates as Candidate[]),
      {
        forceSearch: data.webSearch === true,
        token,
        store,
        canExpand: !!task,
      },
    );
    if (taskId) {
      return Response.json(store.saveAiReview(taskId, owner, index, result), {
        headers: { "Cache-Control": "no-store" },
      });
    }
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
