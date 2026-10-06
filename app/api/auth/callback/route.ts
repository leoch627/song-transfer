import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  getEncryptedCookie,
  OAUTH_COOKIE,
  OAuthState,
  redirectUri,
  SESSION_COOKIE,
  setEncryptedCookie,
  tokenRequest,
} from "@/lib/auth";
import { appUrl } from "@/lib/http";
import { taskOwner } from "@/lib/task-owner";
import { taskStore } from "@/lib/task-store";

export async function GET(request: Request) {
  if (!(await taskOwner()))
    return NextResponse.redirect(`${appUrl()}/?auth=site_login`);
  const params = new URL(request.url).searchParams;
  const pending = await getEncryptedCookie<OAuthState>(OAUTH_COOKIE);
  (await cookies()).delete(OAUTH_COOKIE);
  const state = params.get("state") || "";
  if (
    !pending ||
    Buffer.byteLength(state) !== Buffer.byteLength(pending.state) ||
    !timingSafeEqual(Buffer.from(state), Buffer.from(pending.state))
  )
    return NextResponse.redirect(`${appUrl()}/?auth=invalid_state`);
  if (params.has("error"))
    return NextResponse.redirect(`${appUrl()}/?auth=denied`);
  const code = params.get("code");
  if (!code) return NextResponse.redirect(`${appUrl()}/?auth=failed`);
  try {
    const data = await tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
      code_verifier: pending.verifier,
    });
    const session = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || "",
      expiresAt: Date.now() + data.expires_in * 1000,
      scope: data.scope,
    };
    taskStore().saveAccount((await taskOwner(true))!, session);
    await setEncryptedCookie(SESSION_COOKIE, session, 60 * 60 * 24 * 7);
    return NextResponse.redirect(`${appUrl()}/?auth=success`);
  } catch {
    return NextResponse.redirect(`${appUrl()}/?auth=failed`);
  }
}
