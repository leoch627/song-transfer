import { getAccessToken } from "@/lib/auth";
import {
  AppError,
  errorResponse,
  readBody,
  requireSameOrigin,
} from "@/lib/http";
import { taskOwner } from "@/lib/task-owner";
import { taskStore } from "@/lib/task-store";
import { validateMatch } from "@/lib/task-validation";
import { applyAiReview } from "@/lib/matching";
import type { TaskWorkspace } from "@/lib/task-types";
import type { Match } from "@/lib/types";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
async function identity(context: Context) {
  const owner = await taskOwner();
  if (!owner) throw new AppError("任务不存在或无权访问。", 404);
  return { owner, id: (await context.params).id };
}
export async function GET(_request: Request, context: Context) {
  try {
    const { owner, id } = await identity(context),
      store = taskStore();
    return Response.json(
      { task: store.get(id, owner), quota: store.quota() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request, context: Context) {
  try {
    requireSameOrigin(request);
    const { owner, id } = await identity(context),
      store = taskStore();
    const body = await readBody(request, 16_000_000);
    if (
      body.action === "pause" ||
      body.action === "resume" ||
      body.action === "delete"
    ) {
      if (body.action === "resume") await getAccessToken();
      store.control(id, owner, body.action);
      if (body.action === "delete") return Response.json({ ok: true });
    } else if (body.action === "save") {
      const task = store.get(id, owner);
      const updates: { index: number; match: Match }[] = [];
      if (body.updates !== undefined) {
        if (!Array.isArray(body.updates) || body.updates.length > 10000)
          throw new AppError("保存内容无效。");
        for (const update of body.updates) {
          if (!Number.isInteger(update?.index) || !task.matches[update.index])
            throw new AppError("歌曲位置无效。");
          const original = task.matches[update.index];
          const incoming = update.match as Match;
          if (
            !incoming ||
            !Array.isArray(incoming.candidates) ||
            incoming.candidates.some(
              (c) => !original.candidates.some((o) => o.id === c.id),
            )
          )
            throw new AppError("候选歌曲不属于这个任务。");
          let match = validateMatch(
            { ...incoming, candidates: original.candidates },
            original.source,
          );
          // A stale browser save must not erase a newer server-saved AI review.
          if (
            match &&
            original.aiReview &&
            (original.aiReview.reviewedAt || 0) >
              (match.aiReview?.reviewedAt || 0)
          )
            match = applyAiReview(match, original.aiReview);
          if (match && original.status !== "pending")
            updates.push({ index: update.index, match });
        }
      }
      let workspace: TaskWorkspace | undefined;
      if (body.workspace) {
        const w = body.workspace as TaskWorkspace;
        if (
          typeof w.name !== "string" ||
          w.name.length > 100 ||
          typeof w.isPublic !== "boolean" ||
          typeof w.writeStarted !== "boolean"
        )
          throw new AppError("任务设置无效。");
        if (
          w.result &&
          (typeof w.result.url !== "string" ||
            !/^https:\/\/open\.spotify\.com\/playlist\/[A-Za-z0-9]+$/.test(
              w.result.url,
            ) ||
            !Number.isFinite(w.result.added) ||
            !Number.isFinite(w.result.total))
        )
          throw new AppError("迁移结果无效。");
        workspace = {
          name: w.name,
          isPublic: w.isPublic,
          result: w.result || null,
          writeStarted: w.writeStarted,
        };
      }
      store.save(id, owner, updates, workspace);
    } else throw new AppError("未知任务操作。");
    return Response.json(
      { task: store.get(id, owner), quota: store.quota() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
