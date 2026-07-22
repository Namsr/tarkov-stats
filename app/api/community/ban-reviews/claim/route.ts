import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/client-ip";
import { getCommunityReportsStore } from "@/lib/community-reports-db";
import { getRateLimitHeaders } from "@/lib/rate-limiter";
import { isCommunityReviewEnabled } from "@/lib/seasonal/config";
import { HELPER_COOKIE, helperCookieOptions, signHelperSession, verifyHelperSession } from "@/lib/seasonal/helper-core";

const noStore = { "Cache-Control": "no-store" };

function limit(body: unknown): number | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  return Object.keys(record).length === 1 && Number.isInteger(record.limit) && Number(record.limit) >= 1 && Number(record.limit) <= 3
    ? Number(record.limit) : null;
}

export async function POST(request: NextRequest) {
  const { allowed, headers } = getRateLimitHeaders(getClientIp(request), { bucket: "community-review-claim", max: 10 });
  if (!allowed) return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429, headers: { ...noStore, ...headers } });
  if (!isCommunityReviewEnabled()) return NextResponse.json({ error: "Feature unavailable" }, { status: 404, headers: { ...noStore, ...headers } });
  const requested = limit(await request.json().catch(() => null));
  if (requested === null) return NextResponse.json({ error: "Invalid body" }, { status: 400, headers: { ...noStore, ...headers } });
  const store = await getCommunityReportsStore();
  if (!store) return NextResponse.json({ error: "Storage unavailable" }, { status: 503, headers: { ...noStore, ...headers } });
  let helperId = await verifyHelperSession(request.cookies.get(HELPER_COOKIE)?.value);
  let token: string | null = null;
  if (!helperId) {
    helperId = randomUUID();
    try {
      token = await signHelperSession(helperId);
    } catch {
      return NextResponse.json({ error: "Helper session unavailable" }, { status: 503, headers: { ...noStore, ...headers } });
    }
  }
  const response = NextResponse.json({ candidates: await store.candidates(helperId, requested) }, { headers: { ...noStore, ...headers } });
  if (token) response.cookies.set(HELPER_COOKIE, token, helperCookieOptions());
  return response;
}
