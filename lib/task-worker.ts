import { AppError } from "./http";
import { searchTrack, type SearchOptions } from "./spotify";
import { taskAccessToken } from "./task-session";
import { taskStore, type TaskStore } from "./task-store";
import type { Match, Song } from "./types";

export async function runTaskStep(
  store: TaskStore = taskStore(),
  dependencies?: {
    token: (owner: string) => Promise<string>;
    search: (
      token: string,
      song: Song,
      options: SearchOptions,
    ) => Promise<Match>;
  },
) {
  const task = store.claim();
  if (!task) return false;
  try {
    const item = store.nextSong(task);
    if (!item) {
      store.finish(task, "complete");
      return true;
    }
    const cached = store.cached(task.owner, item.source);
    if (cached) store.completeSong(task, item.index, cached);
    else {
      const token = await (
        dependencies?.token || ((owner) => taskAccessToken(owner, store))
      )(task.owner);
      const match = await (dependencies?.search || searchTrack)(
        token,
        item.source,
        {
          checkpoint: item.checkpoint,
          beforeRequest: () => {
            if (!store.runnable(task))
              throw new AppError("任务已暂停。", 409, undefined, "TASK_PAUSED");
            store.reserveSearch();
          },
          onProgress: (checkpoint) =>
            store.checkpoint(task, item.index, checkpoint),
        },
      );
      store.completeSong(task, item.index, match);
    }
    store.finish(task, store.nextSong(task) ? "queued" : "complete");
  } catch (error) {
    if (error instanceof AppError && error.status === 429) {
      store.cooldown(error.retryAfter || 60, error.reason || "RATE_LIMITED");
      store.finish(
        task,
        "waiting",
        Math.max(
          store.quota().resumeAt,
          store.now() + (error.retryAfter || 60) * 1000,
        ),
        "Spotify 暂时限流，进度已保存，到时自动重试。",
      );
    } else if (error instanceof AppError && error.status === 401) {
      store.finish(task, "needs_auth", 0, error.message);
    } else if (error instanceof AppError && error.reason === "TASK_PAUSED") {
      store.finish(task, "paused");
    } else {
      store.finish(
        task,
        "failed",
        0,
        error instanceof AppError
          ? error.message
          : "网络请求未完成，进度已保存。请继续任务以重试。",
      );
    }
  }
  return true;
}
