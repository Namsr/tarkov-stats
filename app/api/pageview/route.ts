import { NextRequest, NextResponse } from "next/server";
import { getAnalyticsStore } from "@/lib/admin/analytics-db";
import { getClientIp } from "@/lib/client-ip";
import { normalizeTrafficPath } from "@/lib/admin/cloudflare-analytics";
import {
  isBotUserAgent,
  isValidPageviewPath,
  isValidVisitorId,
  normalizeReferrerHost,
} from "@/lib/admin/pageviews";
import { ADMIN_NO_STORE_HEADERS, canonicalAdminHost } from "@/lib/admin/types";

export const runtime = "nodejs";

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_HITS = 60;
const recentHits = new Map<string, number[]>();

function rateLimited(ip: string, now: number): boolean {
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const hits = (recentHits.get(ip) ?? []).filter((at) => at >= cutoff);
  hits.push(now);
  recentHits.set(ip, hits);
  if (recentHits.size > 10_000) {
    for (const [key, value] of recentHits) {
      if (value.every((at) => at < cutoff)) recentHits.delete(key);
      if (recentHits.size <= 5_000) break;
    }
  }
  return hits.length > RATE_LIMIT_MAX_HITS;
}

function noContent(): NextResponse {
  return new NextResponse(null, { status: 204, headers: ADMIN_NO_STORE_HEADERS });
}

/**
 * First-party pageview intake for our own traffic counter.
 * Stores anonymous facts only (normalized path, random visitor id, referrer
 * host) — no IPs, no user agents. Always answers 204 for accepted/dropped
 * hits so the beacon stays silent; 429 only on abuse.
 */
export async function POST(request: NextRequest) {
  const now = Date.now();
  if (rateLimited(getClientIp(request), now)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: ADMIN_NO_STORE_HEADERS });
  }
  // Respect Do Not Track at the protocol level too (the client also skips sending).
  if (request.headers.get("dnt") === "1") return noContent();
  if (isBotUserAgent(request.headers.get("user-agent"))) return noContent();

  const host = canonicalAdminHost(
    request.headers.get("x-forwarded-host") ?? request.headers.get("host"),
  );
  // Non-production hosts (localhost, previews) must not pollute the counter.
  if (!host) return noContent();

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    return noContent();
  }
  const payload = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (!isValidPageviewPath(payload.path) || !isValidVisitorId(payload.visitor)) return noContent();

  const path = normalizeTrafficPath(payload.path);
  // Mirror the Cloudflare panel: admin traffic must not inflate public numbers.
  if (path === "/admin") return noContent();

  let referrerHost = normalizeReferrerHost(payload.referrer);
  // Own domains are navigation noise, not acquisition.
  if (referrerHost && canonicalAdminHost(referrerHost)) referrerHost = null;

  try {
    const store = await getAnalyticsStore();
    store?.recordPageview({ occurredAt: now, host, path, visitorId: payload.visitor, referrerHost });
  } catch {
    // The beacon must never break page rendering; a lost hit is acceptable.
  }
  return noContent();
}
