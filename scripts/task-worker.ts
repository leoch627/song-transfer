import { runTaskStep } from "../lib/task-worker";
import { taskStore } from "../lib/task-store";
import { runAiTaskStep } from "../lib/ai-task-worker";
import { aiConcurrency } from "../lib/ai-config";
import { runTransferStep } from "../lib/transfer-worker";

let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
async function work(step: () => Promise<boolean>) {
  while (!stopping) {
    try {
      const worked = await step();
      await new Promise((resolve) => setTimeout(resolve, worked ? 1000 : 5000));
    } catch {
      console.error("Task storage unavailable; retrying in 5 seconds.");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}
async function main() {
  console.log("SongShift matching, AI and playlist write workers started.");
  await Promise.all([
    work(() => runTaskStep()),
    work(() => runTransferStep()),
    ...Array.from({ length: aiConcurrency() }, () =>
      work(() => runAiTaskStep()),
    ),
  ]);
  taskStore().close();
}
main().catch(() => {
  console.error("Task worker stopped unexpectedly.");
  process.exitCode = 1;
});
