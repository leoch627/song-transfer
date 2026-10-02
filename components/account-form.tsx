"use client";
import { useState } from "react";
import type { User } from "@/lib/accounts";

export function AccountForm({
  onSuccess,
}: {
  onSuccess: (user: User) => void;
}) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <form
      className="account-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        setBusy(true);
        setError("");
        try {
          const response = await fetch("/api/account", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: mode, username, password }),
          });
          const data = await response.json();
          if (!response.ok)
            throw new Error(data.error || "暂时无法登录，请稍后重试。");
          setPassword("");
          onSuccess(data.user);
        } catch (error) {
          setError(error instanceof Error ? error.message : "登录失败。");
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="account-tabs">
        <button
          type="button"
          className={mode === "login" ? "active" : ""}
          onClick={() => {
            setMode("login");
            setError("");
          }}
        >
          登录
        </button>
        <button
          type="button"
          className={mode === "register" ? "active" : ""}
          onClick={() => {
            setMode("register");
            setError("");
          }}
        >
          注册账号
        </button>
      </div>
      <p>登录后，后台任务会保存在账号下，换设备也能接着处理。</p>
      <label htmlFor="account-username">用户名</label>
      <input
        id="account-username"
        autoComplete="username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        minLength={3}
        maxLength={32}
        required
        placeholder="3～32 个文字、数字或下划线"
        disabled={busy}
      />
      <label htmlFor="account-password">密码</label>
      <input
        id="account-password"
        type="password"
        autoComplete={mode === "register" ? "new-password" : "current-password"}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        minLength={8}
        maxLength={128}
        required
        placeholder="至少 8 个字符"
        disabled={busy}
      />
      {error && (
        <p role="alert" className="task-error">
          {error}
        </p>
      )}
      <button
        className="primary-button full-width"
        disabled={busy}
        type="submit"
      >
        {busy ? "请稍候…" : mode === "register" ? "创建账号并登录" : "登录账号"}
      </button>
      <p className="account-note">
        网站账号用于保存任务。Spotify 通过官方页面单独授权，无需向本站提供
        Spotify 密码。请妥善保存网站密码，当前不支持邮件找回。
      </p>
    </form>
  );
}
