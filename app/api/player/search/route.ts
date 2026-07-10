import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { getRateLimitHeaders } from "@/lib/rate-limiter";
import { getClientIp } from "@/lib/client-ip";

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
    const store = await getStore();
    if (!store) {
      return NextResponse.json({ error: "Player search unavailable" }, { status: 503, headers });
    }
    const results = await store.search(name, SEARCH_LIMIT);
    return NextResponse.json(results, { headers });
  } catch {
    return NextResponse.json(
      { error: "Failed to search players" },
      { status: 502, headers }
    );
  }
}
