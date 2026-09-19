import { aiStatus } from "@/lib/ai";
export async function GET() {
  return Response.json(aiStatus(), {
    headers: { "Cache-Control": "no-store" },
  });
}
