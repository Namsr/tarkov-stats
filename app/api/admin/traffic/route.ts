import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { getAnalyticsStore } from "@/lib/admin/analytics-db";
import { fetchCloudflareTraffic } from "@/lib/admin/cloudflare-analytics";
import { ADMIN_NO_STORE_HEADERS, parseAdminDomain, parseAdminPeriod } from "@/lib/admin/types";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const access = await requireAdmin();
  if (!access.ok) return NextResponse.json({ error: "admin_access_denied" }, { status: access.status, headers: ADMIN_NO_STORE_HEADERS });
  const period = parseAdminPeriod(request.nextUrl.searchParams.get("period"));
  const domain = parseAdminDomain(request.nextUrl.searchParams.get("domain"));
  if (!period || !domain) return NextResponse.json({ error: "invalid_query" }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
  const [traffic, store] = await Promise.all([fetchCloudflareTraffic(period, domain), getAnalyticsStore()]);
  const now = Date.parse(traffic.to);
  return NextResponse.json({ ...traffic,
    engagement: store?.visitorEngagement(period, domain, now) ?? null,
    auth: store?.authSummary(period, now) ?? null,
    audience: store?.audienceSummary(period, domain, now) ?? null,
  }, { headers: ADMIN_NO_STORE_HEADERS });
}
