import { NextResponse } from "next/server";
import { getShowcaseStore, type ShowcaseConfig } from "@/lib/admin/showcase-db";
import { isSeasonalRolloutReady, loadSeasonalCycleConfig } from "@/lib/seasonal/config";

export const runtime = "nodejs";

type ShowcaseResponse = ShowcaseConfig & { seasonalCycleId: string | null };

/** The showcase is deliberately public and carries no per-user data, so every
 *  response this route can produce gets this one policy. The empty fallback
 *  used to be built apart from the main path and shipped with no Cache-Control
 *  at all, which made it heuristically cacheable: a shared cache could hold an
 *  empty showcase far longer than the `s-maxage=60` the rest of the route
 *  declares. The client's `cache: "no-store"` does not cover an edge cache.
 *  Routing every branch through `respond` keeps a new one from forgetting it. */
const PUBLIC_CACHE = { "Cache-Control": "public, max-age=30, s-maxage=60" };

function respond(config: ShowcaseResponse) {
  return NextResponse.json(config, { headers: PUBLIC_CACHE });
}

function fallback() {
  return respond({ groupId: null, groupName: null, mode: "regular", aids: [], items: [], seasonalCycleId: null, updatedAt: null });
}

function seasonalCycleId(): string | null {
  try {
    if (!isSeasonalRolloutReady()) return null;
    return loadSeasonalCycleConfig()?.cycleId ?? null;
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    const store = await getShowcaseStore();
    if (!store) return fallback();
    const config = store.getActive();
    return respond({ ...config, seasonalCycleId: seasonalCycleId() });
  } catch (error) {
    console.warn("home showcase read failed", error);
    return fallback();
  }
}
