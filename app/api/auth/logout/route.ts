import { cookies } from "next/headers";
import { OAUTH_COOKIE, SESSION_COOKIE } from "@/lib/auth";
import { errorResponse, requireSameOrigin } from "@/lib/http";
import { taskOwner } from "@/lib/task-owner";
import { taskStore } from "@/lib/task-store";
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const owner = await taskOwner();
    if (owner) taskStore().disconnect(owner);
    const jar = await cookies();
    jar.delete(SESSION_COOKIE);
    jar.delete(OAUTH_COOKIE);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
