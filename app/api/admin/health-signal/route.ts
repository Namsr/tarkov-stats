import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { getAnalyticsStore } from "@/lib/admin/analytics-db";
import { ADMIN_NO_STORE_HEADERS, parseAdminDomain } from "@/lib/admin/types";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const access = await requireAdmin();
  if (!access.ok) return NextResponse.json({ error: "admin_access_denied" }, { status: access.status, headers: ADMIN_NO_STORE_HEADERS });
  const domain = parseAdminDomain(request.nextUrl.searchParams.get("domain"));
  if (!domain) return NextResponse.json({ error: "invalid_query" }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
  const store = await getAnalyticsStore();
  return NextResponse.json(store?.healthSignal(domain) ?? {
    status: "degraded",
    activeIssueCount: 0,
    firstSeenAt: null,
    lastSeenAt: null,
    storageAvailable: false,
  }, { headers: ADMIN_NO_STORE_HEADERS });
}
