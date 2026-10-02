import { cookies } from "next/headers";
import { appUrl } from "./http";
import { newWebSession, sessionHash, sessionUser, type User } from "./accounts";
import { taskStore } from "./task-store";

export const WEB_COOKIE = "songshift_account";
export async function currentUser() {
  return sessionUser((await cookies()).get(WEB_COOKIE)?.value);
}
export async function loginCookie(user: User) {
  const jar = await cookies();
  const old = jar.get(WEB_COOKIE)?.value;
  if (old)
    taskStore()
      .db.prepare("DELETE FROM web_sessions WHERE token_hash=?")
      .run(sessionHash(old));
  jar.set(WEB_COOKIE, newWebSession(user), {
    httpOnly: true,
    secure: appUrl().startsWith("https:"),
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 86400,
  });
}
export async function logoutCookie() {
  const jar = await cookies(),
    token = jar.get(WEB_COOKIE)?.value;
  if (token)
    taskStore()
      .db.prepare("DELETE FROM web_sessions WHERE token_hash=?")
      .run(sessionHash(token));
  jar.delete(WEB_COOKIE);
}
