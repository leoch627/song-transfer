import { cookies } from "next/headers";
import { seal, unseal } from "./crypto";
import { AppError, appUrl } from "./http";

export const SESSION_COOKIE = "songshift_session";
export const OAUTH_COOKIE = "songshift_oauth";
export type Session = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  displayName?: string;
};
export type OAuthState = { state: string; verifier: string };
export function configured() {
  return (
    !!process.env.SPOTIFY_CLIENT_ID &&
    (process.env.SESSION_SECRET?.length || 0) >= 32
  );
}
function secret() {
  if (!configured())
    throw new AppError(
      "请先在 .env.local 配置 SPOTIFY_CLIENT_ID 和至少 32 位的 SESSION_SECRET，然后重启服务。",
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
export async function tokenRequest(params: Record<string, string>) {
  secret();
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      ...params,
      client_id: process.env.SPOTIFY_CLIENT_ID!,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok)
    throw new AppError("Spotify 授权已失效或配置不匹配，请重新连接账号。", 401);
  const data = await response.json();
  if (!data.access_token)
    throw new AppError("Spotify 未返回有效授权，请重新连接。", 401);
  return data as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
}
export async function getAccessToken() {
  let session = await getEncryptedCookie<Session>(SESSION_COOKIE);
  if (!session) throw new AppError("请先连接 Spotify 账号。", 401);
  if (session.expiresAt < Date.now() + 60000) {
    try {
      const data = await tokenRequest({
        grant_type: "refresh_token",
        refresh_token: session.refreshToken,
      });
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
