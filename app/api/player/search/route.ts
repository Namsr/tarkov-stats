import { NextRequest, NextResponse } from "next/server";
import { searchPlayer } from "@/lib/tarkov-api";
import { getRateLimitHeaders } from "@/lib/rate-limiter";

const NICKNAME_RE = /^[a-zA-Z0-9_-]{1,32}$/;

export async function GET(request: NextRequest) {
  // Prefer Cloudflare's trusted client IP; fall back to the proxy's
  // X-Forwarded-For when self-hosted behind Caddy.
  const ip =
    request.headers.get("cf-connecting-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";

  const { allowed, headers } = getRateLimitHeaders(ip);
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
