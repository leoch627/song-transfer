import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { OAUTH_COOKIE, redirectUri, setEncryptedCookie } from "@/lib/auth";
import { appUrl } from "@/lib/http";
import { taskOwner } from "@/lib/task-owner";

export async function GET(request: Request) {
  try {
    if (!(await taskOwner()))
      return NextResponse.redirect(`${appUrl()}/?auth=site_login`);
    // Next.js can use its internal listen address in request.url behind Nginx.
    // Nginx preserves the public Host header for the canonical-host check.
    if (request.headers.get("host") !== new URL(appUrl()).host)
      return NextResponse.redirect(`${appUrl()}/api/auth/login`);
    const verifier = randomBytes(48).toString("base64url");
    const state = randomBytes(24).toString("base64url");
    await setEncryptedCookie(OAUTH_COOKIE, { state, verifier }, 600);
    const params = new URLSearchParams({
      client_id: process.env.SPOTIFY_CLIENT_ID!,
      response_type: "code",
      redirect_uri: redirectUri(),
      scope: "playlist-modify-private playlist-modify-public playlist-read-private",
      state,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    });
    return NextResponse.redirect(
      `https://accounts.spotify.com/authorize?${params}`,
    );
  } catch {
    return NextResponse.redirect(`${appUrl()}/?auth=configuration`);
  }
}
