import { runTaskStep } from "../lib/task-worker";
import { taskStore } from "../lib/task-store";

let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
async function main() {
  console.log("SongShift background task worker started.");
  while (!stopping) {
    try {
      const worked = await runTaskStep();
      await new Promise((resolve) => setTimeout(resolve, worked ? 1000 : 5000));
    } catch {
      console.error("Task storage unavailable; retrying in 5 seconds.");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  taskStore().close();
}
main().catch(() => {
  console.error("Task worker stopped unexpectedly.");
  process.exitCode = 1;
});
