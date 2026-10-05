import { boundedConcurrency } from "./ai-batch";

export const DEFAULT_AI_MODEL = "gpt-6-luna";
export function aiConcurrency() {
  return boundedConcurrency(process.env.AI_REVIEW_CONCURRENCY);
}
