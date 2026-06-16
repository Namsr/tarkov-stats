import { NextRequest, NextResponse } from "next/server";
import { getPlayerProfile } from "@/lib/tarkov-api";
import { getRateLimitHeaders } from "@/lib/rate-limiter";

const AID_RE = /^[0-9]{1,20}$/;

export async function GET(request: NextRequest) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";

  const { allowed, headers } = getRateLimitHeaders(ip);
  if (!allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers }
    );
  }

  const aid = request.nextUrl.searchParams.get("aid");
  if (!aid || !AID_RE.test(aid)) {
    return NextResponse.json(
      { error: "Invalid account ID. Must be numeric." },
      { status: 400, headers }
    );
  }

  const token = request.nextUrl.searchParams.get("token") ?? undefined;

  try {
    const profile = await getPlayerProfile(Number(aid), token);
    return NextResponse.json(profile, { headers });
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch player profile" },
      { status: 502, headers }
    );
  }
}
