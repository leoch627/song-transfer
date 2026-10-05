import { AppError, retryAfterSeconds } from "./http";
import { aiConcurrency } from "./ai-config";

type RelayQueue = {
  active: number;
  waiting: (() => void)[];
  cooldownUntil: number;
};
const shared = globalThis as typeof globalThis & {
  songtransferAiQueue?: RelayQueue;
};
const queue = (shared.songtransferAiQueue ||= {
  active: 0,
  waiting: [],
  cooldownUntil: 0,
});

function checkCooldown() {
  const seconds = Math.ceil((queue.cooldownUntil - Date.now()) / 1000);
  if (seconds > 0)
    throw new AppError(
      `AI 中转站暂时限流，请在 ${seconds} 秒后继续；已有结果已保留。`,
      429,
      seconds,
      "AI_RATE_LIMITED",
    );
}

export async function callAi(body: unknown, style: string, timeoutMs = 60000) {
  checkCooldown();
  await new Promise<void>((resolve) => {
    const enter = () => {
      queue.active++;
      resolve();
    };
    if (queue.active < aiConcurrency()) enter();
    else queue.waiting.push(enter);
  });
  try {
    checkCooldown();
    return await requestAi(body, style, timeoutMs);
  } finally {
    queue.active--;
    queue.waiting.shift()?.();
  }
}

async function requestAi(body: unknown, style: string, timeoutMs: number) {
  if (!process.env.AI_BASE_URL || !process.env.AI_API_KEY)
    throw new AppError("请先配置 AI 中转站。", 503);
  let base: URL;
  try {
    base = new URL(process.env.AI_BASE_URL);
  } catch {
    throw new AppError("AI_BASE_URL 不是有效地址。", 503);
  }
  if (
    (base.protocol !== "https:" &&
      !(
        base.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)
      )) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new AppError(
      "AI 中转站需使用 HTTPS 或本机地址，且不能包含凭证或查询参数。",
      503,
    );
  if (!["responses", "chat_completions"].includes(style))
    throw new AppError(
      "AI_API_STYLE 应为 chat_completions 或 responses。",
      503,
    );
  let response: Response;
  try {
    response = await fetch(
      `${base.href.replace(/\/$/, "")}/${style === "responses" ? "responses" : "chat/completions"}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.AI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
        cache: "no-store",
      },
    );
  } catch {
    throw new AppError("AI 中转站连接失败或超时，已有结果已保留。", 502);
  }
  if (response.status === 401 || response.status === 403)
    throw new AppError("AI 中转站鉴权失败，请检查密钥与模型权限。", 502);
  if (response.status === 429) {
    const seconds = retryAfterSeconds(response.headers.get("retry-after"));
    queue.cooldownUntil = Math.max(
      queue.cooldownUntil,
      Date.now() + seconds * 1000,
    );
    throw new AppError(
      `AI 中转站限流或额度不足，请在 ${seconds} 秒后继续；已完成的复核已保留。`,
      429,
      seconds,
      "AI_RATE_LIMITED",
    );
  }
  if (!response.ok)
    throw new AppError(
      `AI 中转站返回 ${response.status}，请检查模型、接口和工具支持。`,
      502,
    );
  return response.json();
}
