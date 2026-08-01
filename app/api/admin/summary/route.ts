import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { getAnalyticsStore } from "@/lib/admin/analytics-db";
import { fetchCloudflareTrafficRange } from "@/lib/admin/cloudflare-analytics";
import { ADMIN_NO_STORE_HEADERS, parseAdminDomain, parseAdminPeriod, periodMilliseconds } from "@/lib/admin/types";
import { getSuspiciousSummary } from "@/lib/admin/moderation-db";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const access = await requireAdmin();
  if (!access.ok) return NextResponse.json({ error: "admin_access_denied" }, { status: access.status, headers: ADMIN_NO_STORE_HEADERS });
  const period = parseAdminPeriod(request.nextUrl.searchParams.get("period"));
  const domain = parseAdminDomain(request.nextUrl.searchParams.get("domain"));
  if (!period || !domain) return NextResponse.json({ error: "invalid_query" }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });

  const now = Date.now();
  const duration = periodMilliseconds(period);
  const store = await getAnalyticsStore();
  const [traffic, previousTraffic, suspicious] = await Promise.all([
    fetchCloudflareTrafficRange(now - duration, now, domain),
    fetchCloudflareTrafficRange(now - duration * 2, now - duration, domain),
    getSuspiciousSummary().catch(() => null),
  ]);
  const local = store?.summary(period, domain, now) ?? null;
  const previousLocal = store?.summary(period, domain, now - duration) ?? null;
  const metrics = {
    visits: traffic.visits,
    pageviews: traffic.pageviews,
    accountRequests: local?.accountRequests ?? 0,
    newSuspicious: suspicious?.new ?? 0,
    severeRisk: suspicious?.severe ?? 0,
    errors: local?.errors ?? 0,
  };
  const previous = {
    visits: previousTraffic.visits,
    pageviews: previousTraffic.pageviews,
    accountRequests: previousLocal?.accountRequests ?? 0,
    newSuspicious: 0,
    severeRisk: 0,
    errors: previousLocal?.errors ?? 0,
  };
  return NextResponse.json({
    metrics,
    previous,
    series: traffic.series,
    health: local?.health ?? null,
    freshness: local?.freshness ?? null,
    auth: local?.auth ?? { activeUsers: 0, signIns: 0 },
    suspicious,
    storageAvailable: Boolean(store),
    traffic: { available: traffic.available, reason: traffic.reason, sampled: traffic.sampled, from: traffic.from, to: traffic.to },
  }, { headers: ADMIN_NO_STORE_HEADERS });
}
