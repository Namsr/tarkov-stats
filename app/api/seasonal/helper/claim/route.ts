import { NextRequest, NextResponse } from "next/server";
import { helperContext } from "@/lib/seasonal/helper-api";
import { prepareSeasonalScannerCycle } from "@/lib/seasonal/scanner";
export async function POST(request: NextRequest) {
  const context = await helperContext(request, "seasonal-helper-claim", 10);
  if ("response" in context) return context.response;
  const raw = request.nextUrl.searchParams.get("limit") ?? "3";
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 3) return NextResponse.json({ error: "Invalid limit" }, { status: 400 });
  const pollingUntil = await context.store.touchSession(context.helperId);
  await prepareSeasonalScannerCycle(context.cycle);
  const existing = await context.store.listLeases(context.helperId, context.cycle.cycleId);
  const claimed = existing.length >= limit ? [] : await context.seasonal.claimTasks({
    mode: "seasonal", cycleId: context.cycle.cycleId, actor: "helper", owner: context.helperId,
    limit: Math.min(3 - existing.length, limit - existing.length),
  });
  const tasks = [...existing, ...claimed];
  return NextResponse.json({ tasks, pollingUntil }, { headers: { "Cache-Control": "no-store" } });
}
