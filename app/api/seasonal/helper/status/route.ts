import { NextRequest, NextResponse } from "next/server";
import { helperContext } from "@/lib/seasonal/helper-api";
export async function GET(request: NextRequest) {
  const context = await helperContext(request, "seasonal-helper-status", 50);
  if ("response" in context) return context.response;
  const session = await context.store.getSession(context.helperId);
  if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  const now = Date.now();
  return NextResponse.json({ polling: session.polling_until > now, pollingUntil: session.polling_until,
    tasks: await context.store.listLeases(context.helperId, context.cycle.cycleId, now) }, { headers: { "Cache-Control": "no-store" } });
}
