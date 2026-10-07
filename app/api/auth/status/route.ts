import { configured, defaultClientId, redirectUri } from "@/lib/auth";
import { taskOwner } from "@/lib/task-owner";
import { taskStore } from "@/lib/task-store";
export async function GET() {
  const owner = await taskOwner();
  const session = owner ? taskStore().account(owner) : null;
  const custom = owner ? taskStore().spotifyClientId(owner) : "";
  return Response.json(
    {
      configured: configured() && !!(custom || defaultClientId()),
      connected:
        !!session && (session.expiresAt > Date.now() || !!session.refreshToken),
      redirectUri: redirectUri(),
      writeReady: !!session?.scope?.split(" ").includes("playlist-read-private"),
      customClientId: custom,
      defaultAppAvailable: configured() && !!defaultClientId(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
