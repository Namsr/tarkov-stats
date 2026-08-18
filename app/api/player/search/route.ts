import { NextRequest, NextResponse } from "next/server";
import { getPlayerIndexStore } from "@/lib/db";
import { getRateLimitHeaders } from "@/lib/rate-limiter";
import { getClientIp } from "@/lib/client-ip";
import { createRequestTiming } from "@/lib/observability/request-timing";

const NICKNAME_RE = /^[a-zA-Z0-9_-]{1,15}$/;
const SEARCH_LIMIT = 12;

export async function GET(request: NextRequest) {
  const timing = createRequestTiming();
  timing.setRequestContext({
    host: request.headers.get("x-forwarded-host") ?? request.headers.get("host"),
  });
  const ip = getClientIp(request);

  const { allowed, headers } = getRateLimitHeaders(ip, { bucket: "search" });
  if (!allowed) {
    timing.finish({ operation: "player_search", outcome: "rate_limited", status: 429 });
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers }
    );
  }

  const name = request.nextUrl.searchParams.get("name")?.trim();
  if (!name || !NICKNAME_RE.test(name)) {
    timing.finish({ operation: "player_search", outcome: "invalid", status: 400 });
    return NextResponse.json(
      { error: "Invalid nickname. Use alphanumeric characters, dashes, or underscores (1-15 chars)." },
      { status: 400, headers }
    );
  }

  try {
    const index = await getPlayerIndexStore();
    if (!index || !(await index.isReady())) {
      timing.finish({ operation: "player_search", outcome: "unavailable", status: 503 });
      return NextResponse.json(
        { error: "Player nickname index is not ready" },
        { status: 503, headers }
      );
    }
    const results = await index.search(name, SEARCH_LIMIT);
    const exact = results.find((player) => player.name.trim().toLowerCase() === name.toLowerCase());
    timing.setRequestContext({ aid: exact?.aid, nickname: exact?.name ?? null });
    timing.finish({ operation: "player_search", outcome: results.length ? "success" : "not_found", status: 200, source: "index" });
    return NextResponse.json(results, { headers });
  } catch {
    timing.finish({ operation: "player_search", outcome: "error", status: 502 });
    return NextResponse.json(
      { error: "Failed to search players" },
      { status: 502, headers }
    );
  }
}
