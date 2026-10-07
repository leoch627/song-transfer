import { AppError } from "./http";
import type { Session } from "./auth";
import { taskStore, type TaskStore } from "./task-store";

export async function requestSpotifyToken(
  params: Record<string, string>,
  clientId?: string,
) {
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      ...params,
      client_id: clientId || process.env.SPOTIFY_CLIENT_ID!,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
  if (
    response.status === 400 ||
    response.status === 401 ||
    response.status === 403
  )
    throw new AppError("Spotify 授权已失效，请重新连接后继续任务。", 401);
  if (!response.ok)
    throw new AppError("Spotify 授权服务暂时不可用，请稍后重试。", 502);
  const data = await response.json();
  if (!data.access_token)
    throw new AppError("Spotify 未返回有效授权，请重新连接。", 401);
  return data as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };
}

export async function taskAccessToken(
  owner: string,
  store: TaskStore = taskStore(),
) {
  for (let attempt = 0; attempt < 110; attempt++) {
    const session = store.account(owner);
    if (!session) throw new AppError("请重新连接 Spotify，然后继续任务。", 401);
    if (session.expiresAt > Date.now() + 60000) return session.accessToken;
    const lease = store.acquireRefresh(owner);
    if (!lease) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      continue;
    }
    try {
      // A previous refresher may have finished between the read and lease acquisition.
      const latest = store.account(owner);
      if (!latest) throw new AppError("Spotify 已断开连接。", 401);
      if (latest.expiresAt > Date.now() + 60000) return latest.accessToken;
      const data = await requestSpotifyToken(
        {
          grant_type: "refresh_token",
          refresh_token: latest.refreshToken,
        },
        latest.clientId,
      );
      const refreshed: Session = {
        ...latest,
        accessToken: data.access_token,
        refreshToken: data.refresh_token || latest.refreshToken,
        expiresAt: Date.now() + data.expires_in * 1000,
      };
      if (store.finishRefresh(owner, lease, refreshed))
        return refreshed.accessToken;
      // Logout/reconnect replaced this session while the refresh was in flight.
    } finally {
      store.releaseRefresh(owner, lease);
    }
  }
  throw new AppError("Spotify 正在更新授权，请稍后继续。", 503);
}
