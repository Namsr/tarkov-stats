import { NextRequest, NextResponse } from "next/server";
import {
  ARENA_LEADERBOARD_MAX_LIMIT,
  ARENA_PARSER_VERSION,
  getArenaLeaderboard,
} from "@/lib/arena/service";
import { createRequestTiming } from "@/lib/observability/request-timing";

const LEADERBOARD_CACHE_CONTROL =
  "public, max-age=300, s-maxage=300, stale-while-revalidate=300";

function parseLimit(value: string | null): number | null {
  if (value === null || value === "") return 10;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > ARENA_LEADERBOARD_MAX_LIMIT) return null;
  return parsed;
}

function parseOffset(value: string | null): number | null {
  if (value === null || value === "") return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return parsed;
}

export async function GET(request: NextRequest) {
  const timing = createRequestTiming();
  timing.setRequestContext({ host: request.headers.get("x-forwarded-host") ?? request.headers.get("host") });
  const params = request.nextUrl.searchParams;
  const limit = parseLimit(params.get("limit"));
  const offset = parseOffset(params.get("offset"));
  if (limit === null || offset === null) {
    timing.finish({ operation: "arena_leaderboard", mode: "arena", outcome: "invalid", status: 400 });
    return NextResponse.json({ error: "Invalid leaderboard query" }, { status: 400 });
  }
  try {
    const leaderboard = await getArenaLeaderboard(limit, offset);
    if (!leaderboard) {
      timing.finish({ operation: "arena_leaderboard", mode: "arena", outcome: "unavailable", status: 503 });
      return NextResponse.json({ error: "Arena leaderboard is unavailable" }, {
        status: 503,
        headers: { "Retry-After": "5" },
      });
    }
    timing.finish({ operation: "arena_leaderboard", mode: "arena", outcome: "success", status: 200, storage: "sqlite" });
    return NextResponse.json(
      { mode: "arena", schemaVersion: ARENA_PARSER_VERSION, ...leaderboard },
      { headers: { "Cache-Control": LEADERBOARD_CACHE_CONTROL } },
    );
  } catch (error) {
    console.error("Arena leaderboard failed", error);
    timing.finish({ operation: "arena_leaderboard", mode: "arena", outcome: "error", status: 500 });
    return NextResponse.json({ error: "Failed to load Arena leaderboard" }, { status: 500 });
  }
}
