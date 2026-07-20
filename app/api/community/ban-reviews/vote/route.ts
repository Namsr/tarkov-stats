import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/client-ip";
import { getCommunityReportsStore } from "@/lib/community-reports-db";
import { parsePlayerId } from "@/lib/player-id";
import { getRateLimitHeaders } from "@/lib/rate-limiter";
import { isCommunityReviewEnabled } from "@/lib/seasonal/config";
import { HELPER_COOKIE, verifyHelperSession } from "@/lib/seasonal/helper-core";

const noStore = { "Cache-Control": "no-store" };

function vote(body: unknown): { aid: number; verdict: "yes" | "no" } | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || !("aid" in record) || !("verdict" in record)) return null;
  const aid = parsePlayerId(String(record.aid ?? ""));
  return aid !== null && (record.verdict === "yes" || record.verdict === "no") ? { aid, verdict: record.verdict } : null;
}

export async function POST(request: NextRequest) {
  const { allowed, headers } = getRateLimitHeaders(getClientIp(request), { bucket: "community-review-vote", max: 20 });
  if (!allowed) return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429, headers: { ...noStore, ...headers } });
  if (!isCommunityReviewEnabled()) return NextResponse.json({ error: "Feature unavailable" }, { status: 404, headers: { ...noStore, ...headers } });
  const helperId = await verifyHelperSession(request.cookies.get(HELPER_COOKIE)?.value);
  if (!helperId) return NextResponse.json({ error: "Invalid helper session" }, { status: 401, headers: { ...noStore, ...headers } });
  const input = vote(await request.json().catch(() => null));
  if (!input) return NextResponse.json({ error: "Invalid body" }, { status: 400, headers: { ...noStore, ...headers } });
  const store = await getCommunityReportsStore();
  if (!store) return NextResponse.json({ error: "Storage unavailable" }, { status: 503, headers: { ...noStore, ...headers } });
  const result = await store.vote({ ...input, helperId });
  if (result.missing) return NextResponse.json({ error: "Candidate not found" }, { status: 404, headers: { ...noStore, ...headers } });
  return NextResponse.json({ already: result.already, candidates: await store.candidates(helperId, 3) }, { headers: { ...noStore, ...headers } });
}
