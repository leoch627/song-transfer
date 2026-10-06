import { aiConcurrency } from "./ai-config";
import { reviewSong } from "./ai-review-service";
import { AiTaskQueue } from "./ai-task-queue";
import { taskStore, type TaskStore } from "./task-store";
import { taskAccessToken } from "./task-session";

export async function runAiTaskStep(
  store: TaskStore = taskStore(),
  dependencies = {
    token: (owner: string) => taskAccessToken(owner, store),
    review: reviewSong,
  },
) {
  const queue = new AiTaskQueue(store),
    item = queue.claim(aiConcurrency());
  if (!item) return false;
  const heartbeat = setInterval(() => {
    try {
      queue.renew(item);
    } catch {
      /* A lost lease is checked before committing the result. */
    }
  }, 30000);
  try {
    const token = await dependencies.token(item.owner);
    const result = await dependencies.review(
      item.match.source,
      item.match.candidates,
      {
        forceSearch: item.forceSearch,
        token,
        store,
        canExpand: true,
        autonomousSearch: true,
        checkpoint: item.checkpoint,
        onProgress: (checkpoint) => queue.checkpoint(item, checkpoint),
      },
    );
    queue.complete(item, result);
  } catch (error) {
    queue.fail(item, error);
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}
