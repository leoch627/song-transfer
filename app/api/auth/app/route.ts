import { errorResponse, readBody, requireSameOrigin, AppError } from "@/lib/http";
import { taskOwner } from "@/lib/task-owner";
import { taskStore } from "@/lib/task-store";

// Spotify Client IDs are 32 hex characters.
const CLIENT_ID = /^[0-9a-f]{32}$/i;

/** Set (or clear, with an empty value) the user's own Spotify app Client ID. */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const owner = (await taskOwner(true))!;
    const body = await readBody(request, 2000);
    const clientId =
      typeof body.clientId === "string" ? body.clientId.trim().toLowerCase() : "";
    if (clientId && !CLIENT_ID.test(clientId))
      throw new AppError("Client ID 应为 32 位字母数字，请从 Spotify 应用页面复制。", 400);
    const store = taskStore();
    // Changing apps would orphan the stored tokens, so require a clean disconnect.
    if (store.account(owner) && clientId !== store.spotifyClientId(owner))
      throw new AppError("请先断开 Spotify，再更换应用。", 409);
    store.setSpotifyClientId(owner, clientId);
    return Response.json({ ok: true, customClientId: clientId });
  } catch (error) {
    return errorResponse(error);
  }
}
