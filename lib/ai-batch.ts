export const DEFAULT_AI_CONCURRENCY = 3;

export function boundedConcurrency(value: unknown): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0
    ? Math.min(number, 5)
    : DEFAULT_AI_CONCURRENCY;
}

export type BatchProgress = {
  done: number;
  active: number[];
  lastCompleted: number | null;
  failed: boolean;
};

// Stop scheduling on pause/failure, but let in-flight work save its results.
export async function runConcurrentBatch<T>(
  items: T[],
  process: (item: T, index: number) => Promise<void>,
  options: {
    concurrency: number;
    shouldStop: () => boolean;
    onProgress: (progress: BatchProgress) => void;
  },
) {
  let next = 0,
    done = 0,
    lastCompleted: number | null = null;
  let failed = false,
    firstError: unknown;
  const active = new Set<number>();
  const progress = () =>
    options.onProgress({ done, active: [...active], lastCompleted, failed });
  async function worker() {
    while (!failed && !options.shouldStop() && next < items.length) {
      const index = next++;
      active.add(index);
      progress();
      try {
        await process(items[index], index);
        done++;
        lastCompleted = index;
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
      } finally {
        active.delete(index);
        progress();
      }
    }
  }
  await Promise.all(
    Array.from(
      {
        length: Math.min(items.length, boundedConcurrency(options.concurrency)),
      },
      worker,
    ),
  );
  if (failed) throw firstError;
  return done;
}
