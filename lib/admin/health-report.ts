import type { AdminDomain, AdminPeriod } from "./types.ts";
import type { LocalSummary } from "./analytics-db.ts";
import type { BrowserPerformanceSummary } from "./browser-performance-db.ts";
import type { SystemMetricsRange } from "./system-metrics.ts";
import type { AveragePublicationState } from "../average-publication.ts";

export interface HealthDiagnostics {
  from: number; to: number;
  browser: BrowserPerformanceSummary | null;
  runtime: { available: boolean; retentionSamples: number; sampleCount: number; latest: unknown; samples: unknown[] };
  system: { available: boolean; configured: boolean; scope: "host"; data: SystemMetricsRange | null };
  collection: {
    backend: "recorded_requests_excluding_read_only_risk_polls"; browser: "supported_public_pages_dnt_respected";
    runtime: "current_http_process_memory_last_120_samples"; slowRequestLimit: number;
    latencyPercentiles: "successful_requests"; phaseDurations: "may_overlap_do_not_sum_percentiles";
    browserValues: "milliseconds"; clientReady: "navigation_to_react_effect_not_full_hydration";
    browserApi: "resource_timing_includes_browser_cache_no_http_status";
    lcp: "initial_document_at_first_hidden"; unmeasuredBrowserMetrics: string[];
    browserRetentionDays: number; browserDocumentSampleLimit: number; browserMetricGroupLimit: number;
  };
}

export function healthReport(summary: {
  generatedAt: number; period: AdminPeriod; domain: AdminDomain; storageAvailable: boolean;
  health: LocalSummary["health"] | null; freshness: LocalSummary["freshness"] | null;
  averagePublications?: AveragePublicationState[]; diagnostics?: HealthDiagnostics;
}): string {
  return JSON.stringify({
    schema: "tarkovstats_health_v2", generatedAt: new Date(summary.generatedAt).toISOString(),
    period: summary.period, domain: summary.domain, storageAvailable: summary.storageAvailable,
    health: summary.health && {
      ...summary.health,
      operations: summary.health.operations.map((operation) => ({ ...operation,
        entry: operation.operation === "risk_evaluation" ? "background" : "api" })),
      latencyMs: { p50: summary.health.p50Ms, p95: summary.health.p95Ms, p99: summary.health.p99Ms },
      cache: { hits: summary.health.cacheHits, misses: summary.health.cacheMisses },
    },
    freshness: summary.freshness,
    averagePublications: (summary.averagePublications ?? []).map((state) => ({ ...state,
      lastError: state.lastError == null ? null : "publication_failed",
      ageMs: state.generatedAt == null ? null : Math.max(0, summary.generatedAt - state.generatedAt),
      dirtyForMs: state.dirtyAt == null ? null : Math.max(0, summary.generatedAt - state.dirtyAt),
    })),
    diagnostics: summary.diagnostics ?? null,
  }, null, 2);
}
