export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
    public retryAfter?: number,
  ) {
    super(message);
  }
}

export function appUrl() {
  const url = new URL(process.env.APP_URL || "http://127.0.0.1:3002");
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))
  ) {
    throw new AppError(
      "APP_URL 必须使用 HTTPS，本地开发请使用 http://127.0.0.1:3002。",
      503,
    );
  }
  return url.origin;
}

export function requireSameOrigin(request: Request) {
  if (request.headers.get("origin") !== appUrl())
    throw new AppError("请求来源不匹配，请通过配置的 APP_URL 打开网页。", 403);
}

export async function readBody(
  request: Request,
): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new AppError("请使用 JSON 请求。", 415);
  const body = await request.text();
  if (body.length > 1_000_000) throw new AppError("请求内容过大。", 413);
  try {
    const data = JSON.parse(body);
    if (!data || Array.isArray(data) || typeof data !== "object")
      throw new Error();
    return data;
  } catch {
    throw new AppError("请求格式不正确。");
  }
}

export function errorResponse(error: unknown) {
  const known = error instanceof AppError;
  return Response.json(
    {
      error: known ? error.message : "服务暂时无法连接，请稍后重试。",
      retryAfter: known ? error.retryAfter : undefined,
    },
    {
      status: known ? error.status : 502,
      headers: {
        "Cache-Control": "no-store",
        ...(known && error.retryAfter
          ? { "Retry-After": String(error.retryAfter) }
          : {}),
      },
    },
  );
}
