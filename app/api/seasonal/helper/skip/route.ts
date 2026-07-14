import type { NextRequest } from "next/server";
import { helperContext, helperError, parseTaskId } from "@/lib/seasonal/helper-api";
export async function POST(request: NextRequest) {
  const context = await helperContext(request, "seasonal-helper-skip", 20);
  if ("response" in context) return context.response;
  const taskId = await parseTaskId(request);
  if (!taskId) return helperError("Invalid request", 400);
  return await context.store.finish(taskId, context.helperId, "skipped")
    ? Response.json({ skipped: true }, { headers: { "Cache-Control": "no-store" } })
    : helperError("Invalid lease", 409);
}
