import { AppError, errorResponse, requireSameOrigin } from "@/lib/http";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    throw new AppError(
      "匹配已升级为后台任务，请刷新页面后继续，已有进度会保留。",
      409,
    );
  } catch (error) {
    return errorResponse(error);
  }
}
