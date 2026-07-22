import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getClientIp } from "@/lib/client-ip";
import { getCommunityReportsStore } from "@/lib/community-reports-db";
import { getStore, type CrossSectionMode } from "@/lib/db";
import { parsePlayerId } from "@/lib/player-id";
import { getRateLimitHeaders } from "@/lib/rate-limiter";
import { getSeasonalStore } from "@/lib/seasonal/storage";
import { isGameMode, normalizeCycleId, type GameMode } from "@/types/seasonal";

const noStore = { "Cache-Control": "no-store" };

function response(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { ...noStore, ...headers } });
}

function identity(body: unknown): { aid: number; mode: GameMode; cycleId: string } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (Object.keys(record).length !== 3 || !("aid" in record) || !("mode" in record) || !("cycle" in record)) return null;
  const aid = parsePlayerId(String(record.aid ?? ""));
  if (aid === null || !isGameMode(record.mode)) return null;
  const cycleId = normalizeCycleId(record.cycle, record.mode);
  return cycleId === null ? null : { aid, mode: record.mode, cycleId };
}

async function profileExists(input: { aid: number; mode: GameMode; cycleId: string }): Promise<boolean> {
  if (input.mode === "seasonal") {
    const store = await getSeasonalStore();
    return Boolean(store && await store.latestSnapshot(input));
  }
  const store = await getStore(input.mode as CrossSectionMode);
  return Boolean(store && await store.stored(input.aid));
}

export async function GET(request: NextRequest) {
  const aid = parsePlayerId(request.nextUrl.searchParams.get("aid") ?? "");
  if (aid === null) return response({ error: "Invalid account ID" }, 400);
  try {
    const store = await getCommunityReportsStore();
    if (!store) return response({ error: "Storage unavailable" }, 503);
    const session = await getSession();
    return response({ count: await store.count(aid), reportedByMe: session ? await store.reportedBy(session.sub, aid) : false });
  } catch {
    return response({ error: "Storage unavailable" }, 503);
  }
}

export async function POST(request: NextRequest) {
  const { allowed, headers } = getRateLimitHeaders(getClientIp(request), { bucket: "community-reports" });
  if (!allowed) return response({ error: "Rate limit exceeded" }, 429, headers);
  const session = await getSession();
  if (!session) return response({ error: "Unauthorized" }, 401, headers);
  const input = identity(await request.json().catch(() => null));
  if (!input) return response({ error: "Invalid report identity" }, 400, headers);
  try {
    if (!await profileExists(input)) return response({ error: "Profile not found" }, 404, headers);
    const store = await getCommunityReportsStore();
    if (!store) return response({ error: "Storage unavailable" }, 503, headers);
    const result = await store.report({ ...input, userSub: session.sub });
    return response(result, 200, headers);
  } catch {
    return response({ error: "Storage unavailable" }, 503, headers);
  }
}
