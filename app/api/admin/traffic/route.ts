import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { fetchCloudflareTraffic } from "@/lib/admin/cloudflare-analytics";
import { ADMIN_NO_STORE_HEADERS, parseAdminDomain, parseAdminPeriod } from "@/lib/admin/types";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const access = await requireAdmin();
  if (!access.ok) return NextResponse.json({ error: "admin_access_denied" }, { status: access.status, headers: ADMIN_NO_STORE_HEADERS });
  const period = parseAdminPeriod(request.nextUrl.searchParams.get("period"));
  const domain = parseAdminDomain(request.nextUrl.searchParams.get("domain"));
  if (!period || !domain) return NextResponse.json({ error: "invalid_query" }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
  return NextResponse.json(await fetchCloudflareTraffic(period, domain), { headers: ADMIN_NO_STORE_HEADERS });
}
