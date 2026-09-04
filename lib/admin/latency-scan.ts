// On-demand latency scan for the admin console ("Diagnostics" tab).
// Runs a deep percentile test across every latency-relevant subsystem —
// player/index/progression/seasonal/ban/admin storages, internal compute paths
// (publications, aggregates, cohort, analytics summary), all upstream hosts,
// the Cloudflare traffic API, and the runtime event loop — and returns a single
// JSON document that can be pasted into ChatGPT/Claude.
//
// Every probe is read-only and uses the same store/host abstractions as the
// real routes, so the scan measures the active backend (D1 on Cloudflare,
// node:sqlite self-hosted) instead of a synthetic benchmark.

export const LATENCY_SCAN_SCHEMA = "tarkovstats_latency_scan_v1";
export const LATENCY_SCAN_DEFAULT_SAMPLES = 15;
export const LATENCY_SCAN_MIN_SAMPLES = 5;
export const LATENCY_SCAN_MAX_SAMPLES = 30;
export const LATENCY_SCAN_DEFAULT_TIMEOUT_MS = 5000;
export const LATENCY_SCAN_MIN_TIMEOUT_MS = 1000;
export const LATENCY_SCAN_MAX_TIMEOUT_MS = 8000;

export type LatencyProbeId =
  | "analytics_storage"
  | "analytics_summary"
  | "player_storage_regular"
  | "player_storage_pve"
  | "player_storage_arena"
  | "search_index_regular"
  | "search_index_pve"
  | "search_index_arena"
  | "search_index_seasonal"
  | "progression_store"
  | "seasonal_store"
  | "ban_store"
  | "admin_aux_stores"
  | "internal_summary"
  | "average_aggregates"
  | "cohort_lookup"
  | "upstream_json"
  | "upstream_players"
  | "upstream_player_live"
  | "traffic_api_cf"
  | "eventloop";

export type LatencyProbeKind = "storage" | "internal" | "upstream" | "runtime";

export interface LatencySample {
  ms: number | null;
  ok: boolean;
  status?: number | null;
  error?: string | null;
}

export interface LatencyTargetResult {
  id: LatencyProbeId;
  label: string;
  kind: LatencyProbeKind;
  samples: number;
  succeeded: number;
  failed: number;
  minMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
  meanMs: number | null;
  lastError: string | null;
  unavailable: boolean;
  unavailableReason: string | null;
}

export interface LatencyScanResult {
  schema: typeof LATENCY_SCAN_SCHEMA;
  generatedAt: number;
  generatedAtIso: string;
  host: string | null;
  runtime: string;
  samplesPerTarget: number;
  timeoutMs: number;
  durationMs: number;
  targets: LatencyTargetResult[];
}

export const LATENCY_PROBES: ReadonlyArray<{ id: LatencyProbeId; label: string; kind: LatencyProbeKind }> = [
  { id: "analytics_storage", label: "Analytics storage read (healthSignal)", kind: "storage" },
  { id: "analytics_summary", label: "Admin analytics summary (overview/health query)", kind: "internal" },
  { id: "player_storage_regular", label: "Player storage PVP (rangeBounds)", kind: "storage" },
  { id: "player_storage_pve", label: "Player storage PvE (rangeBounds)", kind: "storage" },
  { id: "player_storage_arena", label: "Player storage Arena (rangeBounds)", kind: "storage" },
  { id: "search_index_regular", label: "Nickname search index PVP", kind: "storage" },
  { id: "search_index_pve", label: "Nickname search index PvE", kind: "storage" },
  { id: "search_index_arena", label: "Nickname search index Arena", kind: "storage" },
  { id: "search_index_seasonal", label: "Nickname search index Seasonal", kind: "storage" },
  { id: "progression_store", label: "Progression snapshots (latest)", kind: "storage" },
  { id: "seasonal_store", label: "Seasonal profiles (getProfile)", kind: "storage" },
  { id: "ban_store", label: "Ban database (isAidBanned)", kind: "storage" },
  { id: "admin_aux_stores", label: "Admin aux stores (system metrics + data audit)", kind: "storage" },
  { id: "internal_summary", label: "Internal API (publications + suspicious summary)", kind: "internal" },
  { id: "average_aggregates", label: "Average computation (bracketAggregate)", kind: "internal" },
  { id: "cohort_lookup", label: "Nearby cohort computation (cohort)", kind: "internal" },
  { id: "upstream_json", label: "Upstream json.tarkov.dev", kind: "upstream" },
  { id: "upstream_players", label: "Upstream players.tarkov.dev", kind: "upstream" },
  { id: "upstream_player_live", label: "Upstream player.tarkov.dev (live API host)", kind: "upstream" },
  { id: "traffic_api_cf", label: "Traffic API (Cloudflare GraphQL, 3 samples)", kind: "upstream" },
  { id: "eventloop", label: "Runtime event loop (setTimeout 0)", kind: "runtime" },
];

const UPSTREAM_URLS: Record<string, string> = {
  upstream_json: "https://json.tarkov.dev/regular/tasks",
  upstream_players: "https://players.tarkov.dev/",
  upstream_player_live: "https://player.tarkov.dev/",
};

/** Nickname that matches nothing: exercises the full index miss path (exact + prefix + tombstone check). */
const INDEX_PROBE_NICKNAME = "__latency_probe__";

const UPSTREAM_USER_AGENT = "TarkovStats/0.1 (+https://tarkovstats.ru)";

export function clampSamples(value: unknown): number {
  const n = typeof value === "number" ? Math.floor(value) : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return LATENCY_SCAN_DEFAULT_SAMPLES;
  return Math.max(LATENCY_SCAN_MIN_SAMPLES, Math.min(LATENCY_SCAN_MAX_SAMPLES, n));
}

export function clampTimeoutMs(value: unknown): number {
  const n = typeof value === "number" ? Math.floor(value) : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return LATENCY_SCAN_DEFAULT_TIMEOUT_MS;
  return Math.max(LATENCY_SCAN_MIN_TIMEOUT_MS, Math.min(LATENCY_SCAN_MAX_TIMEOUT_MS, n));
}

/** Percentile over an ascending-sorted array. fraction 0.5 = p50. */
export function percentile(sortedAsc: readonly number[], fraction: number): number | null {
  if (!sortedAsc.length) return null;
  const index = Math.max(0, Math.min(sortedAsc.length - 1, Math.ceil(sortedAsc.length * fraction) - 1));
  const value = sortedAsc[index];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function truncateError(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value ?? "unknown_error");
  return message.length > 160 ? message.slice(0, 157) + "..." : message;
}

export function summarizeSamples(
  id: LatencyProbeId,
  label: string,
  kind: LatencyProbeKind,
  samples: LatencySample[],
  unavailableReason: string | null = null,
): LatencyTargetResult {
  const okValues = samples
    .filter((sample) => sample.ok && typeof sample.ms === "number" && Number.isFinite(sample.ms))
    .map((sample) => Number(sample.ms));
  const failed = samples.length - okValues.length;
  const lastError = [...samples].reverse().find((sample) => !sample.ok)?.error ?? null;
  if (!okValues.length) {
    return {
      id, label, kind,
      samples: samples.length,
      succeeded: 0,
      failed,
      minMs: null, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null, meanMs: null,
      lastError,
      unavailable: unavailableReason != null,
      unavailableReason,
    };
  }
  const sorted = [...okValues].sort((a, b) => a - b);
  const mean = okValues.reduce((sum, value) => sum + value, 0) / okValues.length;
  return {
    id, label, kind,
    samples: samples.length,
    succeeded: okValues.length,
    failed,
    minMs: round1(sorted[0]),
    p50Ms: percentile(sorted, 0.5) == null ? null : round1(percentile(sorted, 0.5) as number),
    p95Ms: percentile(sorted, 0.95) == null ? null : round1(percentile(sorted, 0.95) as number),
    p99Ms: percentile(sorted, 0.99) == null ? null : round1(percentile(sorted, 0.99) as number),
    maxMs: round1(sorted[sorted.length - 1]),
    meanMs: round1(mean),
    lastError,
    unavailable: false,
    unavailableReason: null,
  };
}

function probeMeta(id: LatencyProbeId): { label: string; kind: LatencyProbeKind } {
  const found = LATENCY_PROBES.find((probe) => probe.id === id);
  return found ?? { label: id, kind: "internal" as LatencyProbeKind };
}

async function timed<T>(fn: () => T | Promise<T>): Promise<LatencySample> {
  const start = performance.now();
  try {
    await fn();
    return { ms: performance.now() - start, ok: true };
  } catch (error) {
    return { ms: null, ok: false, error: truncateError(error) };
  }
}

async function probeAnalyticsStorage(samples: number): Promise<LatencyTargetResult> {
  const meta = probeMeta("analytics_storage");
  try {
    // @ts-expect-error Node's strip-types runner needs the extension; Next can bundle it.
    const { getAnalyticsStore } = await import("./analytics-db.ts");
    const store = await getAnalyticsStore();
    if (!store) {
      return summarizeSamples("analytics_storage", meta.label, meta.kind, [], "storage_unavailable");
    }
    const results: LatencySample[] = [];
    for (let i = 0; i < samples; i += 1) {
      results.push(await timed(() => store.healthSignal("all", Date.now())));
    }
    return summarizeSamples("analytics_storage", meta.label, meta.kind, results);
  } catch (error) {
    return summarizeSamples("analytics_storage", meta.label, meta.kind, [], truncateError(error));
  }
}

async function probeAnalyticsSummary(samples: number): Promise<LatencyTargetResult> {
  const meta = probeMeta("analytics_summary");
  try {
    // @ts-expect-error Node's strip-types runner needs the extension; Next can bundle it.
    const { getAnalyticsStore } = await import("./analytics-db.ts");
    const store = await getAnalyticsStore();
    if (!store) {
      return summarizeSamples("analytics_summary", meta.label, meta.kind, [], "storage_unavailable");
    }
    // The real overview/health query incl. percentile SQL — the heaviest admin read.
    const results: LatencySample[] = [];
    for (let i = 0; i < samples; i += 1) {
      results.push(await timed(() => store.summary("15m", "all", Date.now())));
    }
    return summarizeSamples("analytics_summary", meta.label, meta.kind, results);
  } catch (error) {
    return summarizeSamples("analytics_summary", meta.label, meta.kind, [], truncateError(error));
  }
}

async function probePlayerStorage(
  id: "player_storage_regular" | "player_storage_pve" | "player_storage_arena",
  mode: "regular" | "pve" | "arena",
  samples: number,
): Promise<LatencyTargetResult> {
  const meta = probeMeta(id);
  try {
    // @ts-expect-error Node's strip-types runner needs the extension; Next can bundle it.
    const { getStore } = await import("../db.ts");
    const store = await getStore(mode);
    if (!store) {
      return summarizeSamples(id, meta.label, meta.kind, [], "storage_unavailable");
    }
    const results: LatencySample[] = [];
    for (let i = 0; i < samples; i += 1) {
      results.push(await timed(() => store.rangeBounds("hours")));
    }
    return summarizeSamples(id, meta.label, meta.kind, results);
  } catch (error) {
    return summarizeSamples(id, meta.label, meta.kind, [], truncateError(error));
  }
}

async function probeSearchIndex(
  id: "search_index_regular" | "search_index_pve" | "search_index_arena" | "search_index_seasonal",
  samples: number,
): Promise<LatencyTargetResult> {
  const meta = probeMeta(id);
  try {
    let index: { search: (nickname: string, limit: number) => Promise<unknown> } | null = null;
    if (id === "search_index_seasonal") {
      // @ts-expect-error Node's strip-types runner needs the extension; Next can bundle it.
      const { getSeasonalPlayerIndexStore } = await import("../seasonal/search-index.ts");
      index = await getSeasonalPlayerIndexStore("persistent");
    } else {
      // @ts-expect-error Node's strip-types runner needs the extension; Next can bundle it.
      const { getPlayerIndexStore } = await import("../db.ts");
      const mode = id === "search_index_pve" ? "pve" : id === "search_index_arena" ? "arena" : "regular";
      index = await getPlayerIndexStore(mode);
    }
    if (!index) {
      return summarizeSamples(id, meta.label, meta.kind, [], "storage_unavailable");
    }
    const results: LatencySample[] = [];
    for (let i = 0; i < samples; i += 1) {
      results.push(await timed(() => index.search(INDEX_PROBE_NICKNAME, 5)));
    }
    return summarizeSamples(id, meta.label, meta.kind, results);
  } catch (error) {
    return summarizeSamples(id, meta.label, meta.kind, [], truncateError(error));
  }
}

async function probeProgressionStore(samples: number): Promise<LatencyTargetResult> {
  const meta = probeMeta("progression_store");
  try {
    // @ts-expect-error Node's strip-types runner needs the extension; Next can bundle it.
    const { getProgressionStore } = await import("../progression-db.ts");
    const store = await getProgressionStore("regular");
    if (!store) {
      return summarizeSamples("progression_store", meta.label, meta.kind, [], "storage_unavailable");
    }
    // aid 0 never exists: measures a pure indexed-miss read on the snapshots table.
    const results: LatencySample[] = [];
    for (let i = 0; i < samples; i += 1) {
      results.push(await timed(() => store.latest(0)));
    }
    return summarizeSamples("progression_store", meta.label, meta.kind, results);
  } catch (error) {
    return summarizeSamples("progression_store", meta.label, meta.kind, [], truncateError(error));
  }
}

async function probeSeasonalStore(samples: number): Promise<LatencyTargetResult> {
  const meta = probeMeta("seasonal_store");
  try {
    // @ts-expect-error Node's strip-types runner needs the extension; Next can bundle it.
    const { getSeasonalStore } = await import("../seasonal/storage.ts");
    const store = await getSeasonalStore();
    if (!store) {
      return summarizeSamples("seasonal_store", meta.label, meta.kind, [], "storage_unavailable");
    }
    // Identity kept loose on purpose: aid 0 never exists, so this is a pure
    // indexed-miss read regardless of cycle-id branding.
    const read = store.getProfile as unknown as (identity: unknown) => Promise<unknown>;
    const results: LatencySample[] = [];
    for (let i = 0; i < samples; i += 1) {
      results.push(await timed(() => read({ mode: "seasonal", cycleId: "persistent", aid: 0 })));
    }
    return summarizeSamples("seasonal_store", meta.label, meta.kind, results);
  } catch (error) {
    return summarizeSamples("seasonal_store", meta.label, meta.kind, [], truncateError(error));
  }
}

async function probeBanStore(samples: number): Promise<LatencyTargetResult> {
  const meta = probeMeta("ban_store");
  try {
    // @ts-expect-error Node's strip-types runner needs the extension; Next can bundle it.
    const { getBanStore, isAidBanned } = await import("../ban-db.ts");
    if (!(await getBanStore())) {
      return summarizeSamples("ban_store", meta.label, meta.kind, [], "storage_unavailable");
    }
    const results: LatencySample[] = [];
    for (let i = 0; i < samples; i += 1) {
      results.push(await timed(() => isAidBanned(0)));
    }
    return summarizeSamples("ban_store", meta.label, meta.kind, results);
  } catch (error) {
    return summarizeSamples("ban_store", meta.label, meta.kind, [], truncateError(error));
  }
}

async function probeAdminAuxStores(samples: number): Promise<LatencyTargetResult> {
  const meta = probeMeta("admin_aux_stores");
  try {
    // @ts-expect-error Node's strip-types runner needs the extension; Next can bundle it.
    const { getSystemMetricsStore } = await import("./system-metrics.ts");
    // @ts-expect-error Node's strip-types runner needs the extension; Next can bundle it.
    const { getDataAuditStore } = await import("./data-audit.ts");
    const [metrics, audit] = await Promise.all([getSystemMetricsStore(), getDataAuditStore()]);
    if (!metrics && !audit) {
      return summarizeSamples("admin_aux_stores", meta.label, meta.kind, [], "storage_unavailable");
    }
    // The exact reads behind the Monitoring tab and the data-audit panel.
    const results: LatencySample[] = [];
    for (let i = 0; i < samples; i += 1) {
      results.push(await timed(async () => {
        if (metrics) metrics.range("15m");
        if (audit) audit.read();
      }));
    }
    return summarizeSamples("admin_aux_stores", meta.label, meta.kind, results);
  } catch (error) {
    return summarizeSamples("admin_aux_stores", meta.label, meta.kind, [], truncateError(error));
  }
}

async function probeInternalSummary(samples: number): Promise<LatencyTargetResult> {
  const meta = probeMeta("internal_summary");
  try {
    // @ts-expect-error Node's strip-types runner needs the extension; Next can bundle it.
    const { getAveragePublicationStates } = await import("../average-publication.ts");
    // @ts-expect-error Node's strip-types runner needs the extension; Next can bundle it.
    const { getSuspiciousSummary } = await import("./moderation-db.ts");
    const results: LatencySample[] = [];
    for (let i = 0; i < samples; i += 1) {
      results.push(await timed(async () => {
        await getAveragePublicationStates(Date.now());
        await getSuspiciousSummary().catch(() => null);
      }));
    }
    return summarizeSamples("internal_summary", meta.label, meta.kind, results);
  } catch (error) {
    return summarizeSamples("internal_summary", meta.label, meta.kind, [], truncateError(error));
  }
}

async function probeAverageAggregates(samples: number): Promise<LatencyTargetResult> {
  const meta = probeMeta("average_aggregates");
  try {
    // @ts-expect-error Node's strip-types runner needs the extension; Next can bundle it.
    const { getStore } = await import("../db.ts");
    const store = await getStore("regular");
    if (!store) {
      return summarizeSamples("average_aggregates", meta.label, meta.kind, [], "storage_unavailable");
    }
    // The aggregate SQL behind the Average tab.
    const results: LatencySample[] = [];
    for (let i = 0; i < samples; i += 1) {
      results.push(await timed(() => store.bracketAggregate(null)));
    }
    return summarizeSamples("average_aggregates", meta.label, meta.kind, results);
  } catch (error) {
    return summarizeSamples("average_aggregates", meta.label, meta.kind, [], truncateError(error));
  }
}

async function probeCohortLookup(samples: number): Promise<LatencyTargetResult> {
  const meta = probeMeta("cohort_lookup");
  try {
    // @ts-expect-error Node's strip-types runner needs the extension; Next can bundle it.
    const { getStore } = await import("../db.ts");
    const store = await getStore("regular");
    if (!store) {
      return summarizeSamples("cohort_lookup", meta.label, meta.kind, [], "storage_unavailable");
    }
    // The adaptive comparison-group SQL behind the cohort endpoints.
    const results: LatencySample[] = [];
    for (let i = 0; i < samples; i += 1) {
      results.push(await timed(() => store.cohort("hours", 100, 0)));
    }
    return summarizeSamples("cohort_lookup", meta.label, meta.kind, results);
  } catch (error) {
    return summarizeSamples("cohort_lookup", meta.label, meta.kind, [], truncateError(error));
  }
}

async function probeUpstream(id: LatencyProbeId, samples: number, timeoutMs: number): Promise<LatencyTargetResult> {
  const meta = probeMeta(id);
  const url = UPSTREAM_URLS[id];
  const results: LatencySample[] = [];
  for (let i = 0; i < samples; i += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
    const start = performance.now();
    try {
      // Any HTTP answer (even 4xx from the captcha gate) proves the network path
      // is alive, so it counts as success: this probe measures latency, not app health.
      const response = await fetch(url, {
        method: "HEAD",
        cache: "no-store",
        redirect: "manual",
        signal: controller.signal,
        headers: { Accept: "application/json", "User-Agent": UPSTREAM_USER_AGENT },
      });
      results.push({ ms: performance.now() - start, ok: true, status: response.status });
      try { await response.arrayBuffer(); } catch { /* body drain is best-effort */ }
    } catch (error) {
      const message = truncateError(error);
      results.push({ ms: null, ok: false, error: /abort|timeout/i.test(message) ? "timeout" : message });
    } finally {
      clearTimeout(timer);
    }
  }
  return summarizeSamples(id, meta.label, meta.kind, results);
}

async function probeTrafficApiCf(): Promise<LatencyTargetResult> {
  const meta = probeMeta("traffic_api_cf");
  try {
    // @ts-expect-error Node's strip-types runner needs the extension; Next can bundle it.
    const { fetchCloudflareTrafficRange } = await import("./cloudflare-analytics.ts");
    if (!process.env.CLOUDFLARE_ACCOUNT_ID || !process.env.CLOUDFLARE_ANALYTICS_API_TOKEN) {
      return summarizeSamples("traffic_api_cf", meta.label, meta.kind, [], "not_configured");
    }
    // Deliberately few samples: this is the real heavyweight dashboard query,
    // one call already exercises auth + network + GraphQL execution.
    // A graceful `available: false` answer counts as a failed sample.
    const results: LatencySample[] = [];
    for (let i = 0; i < 3; i += 1) {
      results.push(await timed(async () => {
        const traffic = await fetchCloudflareTrafficRange(Date.now() - 300_000, Date.now(), "all");
        if (!traffic.available) throw new Error(traffic.reason ?? "traffic_unavailable");
      }));
    }
    return summarizeSamples("traffic_api_cf", meta.label, meta.kind, results);
  } catch (error) {
    return summarizeSamples("traffic_api_cf", meta.label, meta.kind, [], truncateError(error));
  }
}

async function probeEventloop(samples: number): Promise<LatencyTargetResult> {
  const meta = probeMeta("eventloop");
  const results: LatencySample[] = [];
  for (let i = 0; i < samples; i += 1) {
    const start = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 0));
    results.push({ ms: performance.now() - start, ok: true });
  }
  return summarizeSamples("eventloop", meta.label, meta.kind, results);
}

export async function runLatencyScan(options?: {
  samples?: unknown;
  timeoutMs?: unknown;
  host?: string | null;
}): Promise<LatencyScanResult> {
  const samplesPerTarget = clampSamples(options?.samples);
  const timeoutMs = clampTimeoutMs(options?.timeoutMs);
  const started = performance.now();
  const targets = await Promise.all([
    probeAnalyticsStorage(samplesPerTarget),
    probeAnalyticsSummary(samplesPerTarget),
    probePlayerStorage("player_storage_regular", "regular", samplesPerTarget),
    probePlayerStorage("player_storage_pve", "pve", samplesPerTarget),
    probePlayerStorage("player_storage_arena", "arena", samplesPerTarget),
    probeSearchIndex("search_index_regular", samplesPerTarget),
    probeSearchIndex("search_index_pve", samplesPerTarget),
    probeSearchIndex("search_index_arena", samplesPerTarget),
    probeSearchIndex("search_index_seasonal", samplesPerTarget),
    probeProgressionStore(samplesPerTarget),
    probeSeasonalStore(samplesPerTarget),
    probeBanStore(samplesPerTarget),
    probeAdminAuxStores(samplesPerTarget),
    probeInternalSummary(samplesPerTarget),
    probeAverageAggregates(samplesPerTarget),
    probeCohortLookup(samplesPerTarget),
    probeUpstream("upstream_json", samplesPerTarget, timeoutMs),
    probeUpstream("upstream_players", samplesPerTarget, timeoutMs),
    probeUpstream("upstream_player_live", samplesPerTarget, timeoutMs),
    probeTrafficApiCf(),
    probeEventloop(samplesPerTarget),
  ]);
  const generatedAt = Date.now();
  return {
    schema: LATENCY_SCAN_SCHEMA,
    generatedAt,
    generatedAtIso: new Date(generatedAt).toISOString(),
    host: options?.host ?? null,
    runtime: typeof process?.release?.name === "string" ? `${process.release.name}/${process.version}` : "unknown",
    samplesPerTarget,
    timeoutMs,
    durationMs: Math.round((performance.now() - started) * 10) / 10,
    targets,
  };
}

/** Merge server scan with browser-measured round-trip so the AI sees full context. */
export function buildAiReport(
  scan: LatencyScanResult,
  client?: { roundTripMs?: number | null; pageUrl?: string | null } | null,
): string {
  return JSON.stringify({
    ...scan,
    client: {
      roundTripMs: typeof client?.roundTripMs === "number" ? Math.round(client.roundTripMs * 10) / 10 : null,
      pageUrl: client?.pageUrl ?? null,
      note: "Paste this whole JSON into ChatGPT/Claude and ask it to diagnose slow p50/p95/p99, failed probes, and what to check next.",
    },
  }, null, 2);
}
