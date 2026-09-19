import { cookies } from "next/headers";
import { OAUTH_COOKIE, SESSION_COOKIE } from "@/lib/auth";
import { errorResponse, requireSameOrigin } from "@/lib/http";
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const jar = await cookies();
    jar.delete(SESSION_COOKIE);
    jar.delete(OAUTH_COOKIE);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
