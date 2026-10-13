import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { getAnalyticsStore } from "@/lib/admin/analytics-db";
import { fetchCloudflareTrafficRange } from "@/lib/admin/cloudflare-analytics";
import { ADMIN_NO_STORE_HEADERS, parseAdminDomain, parseAdminPeriod, periodMilliseconds } from "@/lib/admin/types";
import { getSuspiciousSummary } from "@/lib/admin/moderation-db";
import { getAveragePublicationStates } from "@/lib/average-publication";
import { getSystemMetricsStore } from "@/lib/admin/system-metrics";
import { runtimeHealthReport } from "@/lib/observability/runtime-health.mjs";
import type { HealthDiagnostics } from "@/lib/admin/health-report";

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
  const previousLocal = store?.summary(period, domain, now - duration, false) ?? null;
  const own = store?.pageviewSummary(period, domain, now) ?? null;
  const previousOwn = store?.pageviewSummary(period, domain, now - duration, false) ?? null;
  const averagePublications = await getAveragePublicationStates(now);
  const systemStore = await getSystemMetricsStore();
  const diagnostics: HealthDiagnostics = {
    from: now - duration, to: now,
    browser: store?.browserPerformanceSummary(period, domain, now) ?? null,
    runtime: runtimeHealthReport(now - duration, now),
    system: { available: Boolean(systemStore), configured: (process.env.SYSTEM_METRICS_INGEST_TOKEN?.trim() ?? "").length >= 32,
      scope: "host", data: systemStore?.range(period, now) ?? null },
    collection: { backend: "recorded_requests_excluding_read_only_risk_polls", browser: "supported_public_pages_dnt_respected",
      runtime: "current_http_process_memory_last_120_samples", slowRequestLimit: 30,
      latencyPercentiles: "successful_requests", phaseDurations: "may_overlap_do_not_sum_percentiles",
      browserValues: "milliseconds", clientReady: "navigation_to_react_effect_not_full_hydration",
      browserApi: "resource_timing_includes_browser_cache_no_http_status", lcp: "initial_document_at_first_hidden",
      browserRetentionDays: 7, browserDocumentSampleLimit: 400, browserMetricGroupLimit: 150,
      unmeasuredBrowserMetrics: ["INP", "CLS", "full_hydration", "client_render_after_api"] },
  };
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
    generatedAt: now,
    period,
    domain,
    metrics,
    previous,
    series: traffic.series,
    own,
    previousOwn,
    health: local?.health ?? null,
    freshness: local?.freshness ?? null,
    auth: local?.auth ?? { activeUsers: 0, signIns: 0 },
    audience: store?.audienceSummary(period, domain, now) ?? null,
    suspicious,
    storageAvailable: Boolean(store),
    traffic: { available: traffic.available, reason: traffic.reason, sampled: traffic.sampled, from: traffic.from, to: traffic.to },
    averagePublications,
    diagnostics,
  }, { headers: ADMIN_NO_STORE_HEADERS });
}
