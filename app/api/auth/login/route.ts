import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import {
  defaultClientId,
  OAUTH_COOKIE,
  redirectUri,
  setEncryptedCookie,
} from "@/lib/auth";
import { appUrl } from "@/lib/http";
import { taskOwner } from "@/lib/task-owner";
import { taskStore } from "@/lib/task-store";

export async function GET(request: Request) {
  try {
    const owner = await taskOwner();
    if (!owner) return NextResponse.redirect(`${appUrl()}/?auth=site_login`);
    // Next.js can use its internal listen address in request.url behind Nginx.
    // Nginx preserves the public Host header for the canonical-host check.
    if (request.headers.get("host") !== new URL(appUrl()).host)
      return NextResponse.redirect(`${appUrl()}/api/auth/login`);
    const verifier = randomBytes(48).toString("base64url");
    const state = randomBytes(24).toString("base64url");
    // The user's own Spotify app (own quota) wins over the site default.
    const clientId = taskStore().spotifyClientId(owner) || defaultClientId();
    if (!clientId) throw new Error("No Spotify app configured");
    await setEncryptedCookie(OAUTH_COOKIE, { state, verifier, clientId }, 600);
    const params = new URLSearchParams({
      client_id: clientId,
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
