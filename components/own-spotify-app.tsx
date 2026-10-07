"use client";

import { useState } from "react";
import { ExternalLink } from "lucide-react";
import type { AuthStatus } from "@/lib/types";

// Optional: a user with Spotify Premium can register their own Spotify app and
// use its Client ID, so their requests count against their own quota and do not
// take one of the five user slots of the site's default app.
export function OwnSpotifyApp({
  auth,
  loggedIn,
  onSaved,
}: {
  auth: AuthStatus;
  loggedIn: boolean;
  onSaved: (clientId: string) => void;
}) {
  const [value, setValue] = useState(auth.customClientId || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const using = !!auth.customClientId;

  async function save(clientId: string) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存失败，请重试。");
      setValue(data.customClientId);
      onSaved(data.customClientId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-netease own-app">
      <h3>使用自己的 Spotify 应用（可选）</h3>
      <p>
        {using
          ? "当前使用你自己的应用，请求额度和用户名额都是你自己的。"
          : auth.defaultAppAvailable
            ? "默认使用本站的应用，名额有限（最多 5 位用户）。有 Spotify Premium 的话，可以改用自己的应用。"
            : "本站没有默认应用，请填入你自己的 Spotify 应用 Client ID。"}
      </p>
      {!loggedIn ? (
        <p>请先登录网站账号。</p>
      ) : (
        <>
          <details>
            <summary>怎么创建自己的应用？</summary>
            <ol>
              <li>
                打开{" "}
                <a
                  href="https://developer.spotify.com/dashboard"
                  target="_blank"
                  rel="noreferrer"
                >
                  Spotify Developer Dashboard <ExternalLink size={12} />
                </a>
                ，登录后点「Create app」。
              </li>
              <li>
                Redirect URI 填：<code>{auth.redirectUri}</code>
              </li>
              <li>API 选 Web API，保存。</li>
              <li>
                在应用的 Settings 里复制 Client ID（32 位），粘贴到下面。不需要
                Client Secret，请不要填它。
              </li>
              <li>
                开发模式下应用所有者需要 Premium；你自己授权使用即可，不需要再添加别人。
              </li>
            </ol>
          </details>
          <div className="own-app-row">
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="32 位 Client ID"
              spellCheck={false}
              autoComplete="off"
              maxLength={64}
              aria-label="Spotify Client ID"
            />
            <button
              className="secondary-button"
              disabled={busy || value.trim() === (auth.customClientId || "")}
              onClick={() => save(value.trim())}
            >
              保存
            </button>
            {using && (
              <button
                className="text-button"
                disabled={busy}
                onClick={() => save("")}
              >
                改回默认
              </button>
            )}
          </div>
          {auth.connected && (
            <p>已连接 Spotify。更换应用前请先断开 Spotify，再重新连接。</p>
          )}
          {error && <p className="own-app-error">{error}</p>}
        </>
      )}
    </div>
  );
}
