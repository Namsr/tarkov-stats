import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { adminReports } from "@/lib/admin/reports";
import { ADMIN_NO_STORE_HEADERS, parseAdminDomain, parseAdminPeriod } from "@/lib/admin/types";
import { runtimeHealthReport } from "@/lib/observability/runtime-health.mjs";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const access = await requireAdmin();
  if (!access.ok) return NextResponse.json({ error: "admin_access_denied" }, { status: access.status, headers: ADMIN_NO_STORE_HEADERS });
  const period = parseAdminPeriod(request.nextUrl.searchParams.get("period"));
  const domain = parseAdminDomain(request.nextUrl.searchParams.get("domain"));
  const refresh = request.nextUrl.searchParams.get("refresh");
  if (!period || !domain || (refresh !== null && refresh !== "1")) {
    return NextResponse.json({ error: "invalid_query" }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
  }
  const state = adminReports.read(period, domain, refresh === "1");
  const report = state.report && { ...state.report, diagnostics: { ...state.report.diagnostics,
    runtime: runtimeHealthReport(state.report.diagnostics.from, state.report.diagnostics.to) } };
  return NextResponse.json({ ...state, report }, {
    status: state.status === "running" ? 202 : state.status === "error" ? 503 : 200,
    headers: ADMIN_NO_STORE_HEADERS,
  });
}
