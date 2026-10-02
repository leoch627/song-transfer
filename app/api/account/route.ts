import { cookies } from "next/headers";
import {
  loginAccount,
  normalizeUsername,
  rateLimitAccount,
  registerAccount,
  sessionHash,
} from "@/lib/accounts";
import { currentUser, loginCookie, logoutCookie } from "@/lib/web-auth";
import {
  AppError,
  errorResponse,
  readBody,
  requireSameOrigin,
} from "@/lib/http";
import {
  getEncryptedCookie,
  OAUTH_COOKIE,
  SESSION_COOKIE,
  type Session,
} from "@/lib/auth";
import { taskStore } from "@/lib/task-store";

export const runtime = "nodejs";
export async function GET() {
  try {
    return Response.json(
      { user: await currentUser() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const body = await readBody(request, 10000);
    const jar = await cookies();
    if (body.action === "logout") {
      await logoutCookie();
      jar.delete(SESSION_COOKIE);
      jar.delete(OAUTH_COOKIE);
      return Response.json({ user: null });
    }
    if (body.action !== "login" && body.action !== "register")
      throw new AppError("未知账号操作。");
    const name = normalizeUsername(body.username);
    const ip = request.headers.get("x-real-ip") || "local";
    rateLimitAccount(`ip:${sessionHash(ip)}`, 30, 15 * 60000);
    rateLimitAccount(`name:${name}`, 10, 15 * 60000);
    if (body.action === "register")
      rateLimitAccount(`register:${sessionHash(ip)}`, 5, 3600000);
    const previous = await currentUser();
    const user =
      body.action === "register"
        ? await registerAccount(name, body.password)
        : await loginAccount(name, body.password);
    if (!previous) {
      // Adopt only anonymous data from this browser, never another signed-in user's tasks.
      const legacyOwner = await getEncryptedCookie<string>("songshift_tasks");
      const legacySession = await getEncryptedCookie<Session>(SESSION_COOKIE);
      const store = taskStore();
      if (
        legacyOwner &&
        !store.db.prepare("SELECT id FROM users WHERE id=?").get(legacyOwner)
      ) {
        store.db
          .prepare("UPDATE tasks SET owner=? WHERE owner=?")
          .run(user.id, legacyOwner);
        if (!store.account(user.id)) {
          const account = store.account(legacyOwner);
          if (account) store.saveAccount(user.id, account);
        }
        store.db
          .prepare("DELETE FROM task_accounts WHERE owner=?")
          .run(legacyOwner);
      }
      if (legacySession && !store.account(user.id))
        store.saveAccount(user.id, legacySession);
    }
    jar.delete("songshift_tasks");
    jar.delete(SESSION_COOKIE);
    jar.delete(OAUTH_COOKIE);
    await loginCookie(user);
    return Response.json(
      { user },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
