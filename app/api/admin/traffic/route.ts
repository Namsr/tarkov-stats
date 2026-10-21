import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { getAnalyticsStore, type AuthSummary, type AudienceSummary, type VisitorEngagement } from "@/lib/admin/analytics-db";
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
  const local: { engagement: VisitorEngagement | null; auth: AuthSummary | null; audience: AudienceSummary | null } = {
    engagement: null, auth: null, audience: null,
  };
  if (store) {
    try {
      Object.assign(local, {
        engagement: store.visitorEngagement(period, domain, now),
        auth: store.authSummary(period, now),
        audience: store.audienceSummary(period, domain, now),
      });
    } catch {
      // A busy/unavailable local database must not hide Cloudflare traffic.
      console.warn("admin traffic: local audience query unavailable");
    }
  }
  return NextResponse.json({ ...traffic, ...local }, { headers: ADMIN_NO_STORE_HEADERS });
}
