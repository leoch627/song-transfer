import { cookies } from "next/headers";
import { seal, unseal } from "./crypto";
import { AppError, appUrl } from "./http";
import { taskOwner } from "./task-owner";
import { taskStore } from "./task-store";
import { requestSpotifyToken, taskAccessToken } from "./task-session";

export const SESSION_COOKIE = "songshift_session";
export const OAUTH_COOKIE = "songshift_oauth";
export type Session = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  displayName?: string;
  scope?: string;
  /** Spotify app this session was authorised with; absent = the site default. */
  clientId?: string;
};
export type OAuthState = { state: string; verifier: string; clientId?: string };
/** Session secret is present (needed for every encrypted cookie). */
export function configured() {
  return (process.env.SESSION_SECRET?.length || 0) >= 32;
}
/** Site-wide default Spotify app from the environment. */
export function defaultClientId() {
  return process.env.SPOTIFY_CLIENT_ID || "";
}
function secret() {
  if (!configured())
    throw new AppError(
      "请先在 .env.local 配置至少 32 位的 SESSION_SECRET，然后重启服务。",
      503,
    );
  return process.env.SESSION_SECRET!;
}
export function redirectUri() {
  return `${appUrl()}/api/auth/callback`;
}
export async function setEncryptedCookie(
  name: string,
  value: unknown,
  maxAge: number,
) {
  (await cookies()).set(name, seal(value, secret(), maxAge), {
    httpOnly: true,
    secure: appUrl().startsWith("https:"),
    sameSite: "lax",
    path: "/",
    maxAge,
  });
}
export async function getEncryptedCookie<T>(name: string): Promise<T | null> {
  const value = (await cookies()).get(name)?.value;
  return value && configured() ? unseal<T>(value, secret()) : null;
}
export async function tokenRequest(
  params: Record<string, string>,
  clientId?: string,
) {
  secret();
  return requestSpotifyToken(params, clientId);
}
export async function getAccessToken() {
  const owner = (await taskOwner(true))!;
  if (taskStore().account(owner)) return taskAccessToken(owner);
  let session = await getEncryptedCookie<Session>(SESSION_COOKIE);
  if (!session) throw new AppError("请先连接 Spotify 账号。", 401);
  if (session.expiresAt < Date.now() + 60000) {
    try {
      const data = await tokenRequest(
        {
          grant_type: "refresh_token",
          refresh_token: session.refreshToken,
        },
        session.clientId,
      );
      session = {
        ...session,
        accessToken: data.access_token,
        refreshToken: data.refresh_token || session.refreshToken,
        expiresAt: Date.now() + data.expires_in * 1000,
      };
      await setEncryptedCookie(SESSION_COOKIE, session, 60 * 60 * 24 * 7);
    } catch (error) {
      if (error instanceof AppError && error.status === 401)
        (await cookies()).delete(SESSION_COOKIE);
      throw error;
    }
  }
  return session.accessToken;
}
