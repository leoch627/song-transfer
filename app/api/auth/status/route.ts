import { configured, redirectUri } from "@/lib/auth";
import { taskOwner } from "@/lib/task-owner";
import { taskStore } from "@/lib/task-store";
export async function GET() {
  const owner = await taskOwner();
  const session = owner ? taskStore().account(owner) : null;
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
