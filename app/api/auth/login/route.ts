import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { OAUTH_COOKIE, redirectUri, setEncryptedCookie } from "@/lib/auth";
import { appUrl } from "@/lib/http";

export async function GET(request: Request) {
  try {
    if (new URL(request.url).origin !== appUrl())
      return NextResponse.redirect(`${appUrl()}/api/auth/login`);
    const verifier = randomBytes(48).toString("base64url");
    const state = randomBytes(24).toString("base64url");
    await setEncryptedCookie(OAUTH_COOKIE, { state, verifier }, 600);
    const params = new URLSearchParams({
      client_id: process.env.SPOTIFY_CLIENT_ID!,
      response_type: "code",
      redirect_uri: redirectUri(),
      scope: "playlist-modify-private playlist-modify-public",
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
