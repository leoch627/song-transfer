import {
  configured,
  getEncryptedCookie,
  redirectUri,
  Session,
  SESSION_COOKIE,
} from "@/lib/auth";
export async function GET() {
  const session = await getEncryptedCookie<Session>(SESSION_COOKIE);
  return Response.json(
    {
      configured: configured(),
      connected:
        !!session && (session.expiresAt > Date.now() || !!session.refreshToken),
      redirectUri: redirectUri(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
