import { NextRequest, NextResponse } from "next/server";
import { getRateLimitHeaders } from "@/lib/rate-limiter";
import { getClientIp } from "@/lib/client-ip";
import { getPlayerIndexStore } from "@/lib/db";

const NICKNAME_RE = /^[a-zA-Z0-9_-]{1,15}$/;
const SEARCH_LIMIT = 12;

export async function GET(request: NextRequest) {
  const ip = getClientIp(request);

  const { allowed, headers } = getRateLimitHeaders(ip, { bucket: "search" });
  if (!allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers }
    );
  }

  const name = request.nextUrl.searchParams.get("name")?.trim();
  if (!name || !NICKNAME_RE.test(name)) {
    return NextResponse.json(
      { error: "Invalid nickname. Use alphanumeric characters, dashes, or underscores (1-15 chars)." },
      { status: 400, headers }
    );
  }

  try {
    const index = await getPlayerIndexStore();
    if (!index || !(await index.isReady())) {
      return NextResponse.json(
        { error: "Player nickname index is not ready" },
        { status: 503, headers }
      );
    }

    const results = await index.search(name, SEARCH_LIMIT);
    return NextResponse.json(results, { headers });
  } catch {
    return NextResponse.json(
      { error: "Failed to search players" },
      { status: 502, headers }
    );
  }
}
