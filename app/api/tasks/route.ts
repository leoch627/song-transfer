import {
  getAccessToken,
  getEncryptedCookie,
  SESSION_COOKIE,
  type Session,
} from "@/lib/auth";
import {
  AppError,
  errorResponse,
  readBody,
  requireSameOrigin,
} from "@/lib/http";
import { taskOwner } from "@/lib/task-owner";
import { taskStore } from "@/lib/task-store";
import { validateMatch, validatePlaylist } from "@/lib/task-validation";

export const runtime = "nodejs";
export async function GET() {
  try {
    const owner = await taskOwner();
    const store = taskStore();
    return Response.json(
      { tasks: owner ? store.list(owner) : [], quota: store.quota() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    await getAccessToken();
    const body = await readBody(request, 16_000_000);
    const playlist = validatePlaylist(body.playlist);
    const raw = Array.isArray(body.matches) ? body.matches : [];
    const matches = playlist.songs.map((song, i) =>
      validateMatch(raw[i], song),
    );
    const owner = (await taskOwner(true))!;
    const store = taskStore();
    if (!store.account(owner)) {
      const session = await getEncryptedCookie<Session>(SESSION_COOKIE);
      if (!session) throw new AppError("请先连接 Spotify。", 401);
      store.saveAccount(owner, session);
    }
    if (
      typeof body.requestId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(body.requestId)
    )
      throw new AppError("任务编号无效。");
    const id = store.create(owner, playlist, matches, body.requestId);
    return Response.json(
      { task: store.get(id, owner), quota: store.quota() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
