import { NextRequest, NextResponse } from "next/server";
import { searchPlayer } from "@/lib/tarkov-api";
import { getRateLimitHeaders } from "@/lib/rate-limiter";
import { getClientIp } from "@/lib/client-ip";

const NICKNAME_RE = /^[a-zA-Z0-9_-]{1,32}$/;

export async function GET(request: NextRequest) {
  const ip = getClientIp(request);

  const { allowed, headers } = getRateLimitHeaders(ip, { bucket: "search" });
  if (!allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers }
    );
  }

  const name = request.nextUrl.searchParams.get("name");
  if (!name || !NICKNAME_RE.test(name)) {
    return NextResponse.json(
      { error: "Invalid nickname. Use alphanumeric characters, dashes, or underscores (1-32 chars)." },
      { status: 400, headers }
    );
  }

  const token = request.nextUrl.searchParams.get("token") ?? undefined;

  try {
    const results = await searchPlayer(name, token);
    return NextResponse.json(results, { headers });
  } catch {
    return NextResponse.json(
      { error: "Failed to search players" },
      { status: 502, headers }
    );
  }
}
