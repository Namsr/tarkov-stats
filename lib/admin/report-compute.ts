import { getAnalyticsStore } from "./analytics-db.ts";
import { getSystemMetricsStore } from "./system-metrics.ts";
import { getAveragePublicationStates } from "../average-publication.ts";
import { periodMilliseconds } from "./types.ts";
import type { HealthDiagnostics } from "./health-report.ts";
import type { AdminReportJob } from "./report-worker.ts";

// Runs only in the bounded child. HTTP runtime samples are added by the route,
// since sampling this process would describe the report worker instead of web.
export async function computeAdminReport({ period, domain, now }: AdminReportJob) {
  const store = await getAnalyticsStore();
  const local = store?.summary(period, domain, now) ?? null;
  const averagePublications = await getAveragePublicationStates(now);
  const systemStore = await getSystemMetricsStore();
  const diagnostics: HealthDiagnostics = {
    from: now - periodMilliseconds(period), to: now,
    browser: store?.browserPerformanceSummary(period, domain, now) ?? null,
    runtime: { available: false, retentionSamples: 120, sampleCount: 0, latest: null, samples: [] },
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
  return { generatedAt: now, period, domain, storageAvailable: Boolean(store),
    health: local?.health ?? null, freshness: local?.freshness ?? null, averagePublications, diagnostics };
}
