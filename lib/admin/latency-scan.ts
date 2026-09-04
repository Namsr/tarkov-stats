// On-demand latency scan for the admin console ("Diagnostics" tab).
// Runs a deep percentile test across storage + internal API + upstream + runtime,
// and returns a single JSON document that can be pasted into ChatGPT/Claude.

export const LATENCY_SCAN_SCHEMA = "tarkovstats_latency_scan_v1";
export const LATENCY_SCAN_DEFAULT_SAMPLES = 15;
export const LATENCY_SCAN_MIN_SAMPLES = 5;
export const LATENCY_SCAN_MAX_SAMPLES = 30;
export const LATENCY_SCAN_DEFAULT_TIMEOUT_MS = 5000;
export const LATENCY_SCAN_MIN_TIMEOUT_MS = 1000;
export const LATENCY_SCAN_MAX_TIMEOUT_MS = 8000;

export type LatencyProbeId =
  | "analytics_storage"
  | "player_storage"
  | "internal_summary"
  | "upstream_json"
  | "upstream_players"
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
  { id: "player_storage", label: "Player storage read (rangeBounds)", kind: "storage" },
  { id: "internal_summary", label: "Internal API (average publications)", kind: "internal" },
  { id: "upstream_json", label: "Upstream json.tarkov.dev", kind: "upstream" },
  { id: "upstream_players", label: "Upstream players.tarkov.dev", kind: "upstream" },
  { id: "eventloop", label: "Runtime event loop (setTimeout 0)", kind: "runtime" },
];

const UPSTREAM_URLS: Record<string, string> = {
  upstream_json: "https://json.tarkov.dev/regular/tasks",
  upstream_players: "https://players.tarkov.dev/",
};

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
      try {
        const start = performance.now();
        store.healthSignal("all", Date.now());
        results.push({ ms: performance.now() - start, ok: true });
      } catch (error) {
        results.push({ ms: null, ok: false, error: truncateError(error) });
      }
    }
    return summarizeSamples("analytics_storage", meta.label, meta.kind, results);
  } catch (error) {
    return summarizeSamples("analytics_storage", meta.label, meta.kind, [], truncateError(error));
  }
}

async function probePlayerStorage(samples: number): Promise<LatencyTargetResult> {
  const meta = probeMeta("player_storage");
  try {
    // @ts-expect-error Node's strip-types runner needs the extension; Next can bundle it.
    const { getStore } = await import("../db.ts");
    const store = await getStore("regular");
    if (!store) {
      return summarizeSamples("player_storage", meta.label, meta.kind, [], "storage_unavailable");
    }
    const results: LatencySample[] = [];
    for (let i = 0; i < samples; i += 1) {
      try {
        const start = performance.now();
        await store.rangeBounds("hours");
        results.push({ ms: performance.now() - start, ok: true });
      } catch (error) {
        results.push({ ms: null, ok: false, error: truncateError(error) });
      }
    }
    return summarizeSamples("player_storage", meta.label, meta.kind, results);
  } catch (error) {
    return summarizeSamples("player_storage", meta.label, meta.kind, [], truncateError(error));
  }
}

async function probeInternalSummary(samples: number): Promise<LatencyTargetResult> {
  const meta = probeMeta("internal_summary");
  try {
    // @ts-expect-error Node's strip-types runner needs the extension; Next can bundle it.
    const { getAveragePublicationStates } = await import("../average-publication.ts");
    const results: LatencySample[] = [];
    for (let i = 0; i < samples; i += 1) {
      try {
        const start = performance.now();
        await getAveragePublicationStates(Date.now());
        results.push({ ms: performance.now() - start, ok: true });
      } catch (error) {
        results.push({ ms: null, ok: false, error: truncateError(error) });
      }
    }
    return summarizeSamples("internal_summary", meta.label, meta.kind, results);
  } catch (error) {
    return summarizeSamples("internal_summary", meta.label, meta.kind, [], truncateError(error));
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
      const response = await fetch(url, {
        method: "HEAD",
        cache: "no-store",
        redirect: "manual",
        signal: controller.signal,
        headers: { Accept: "application/json", "User-Agent": UPSTREAM_USER_AGENT },
      });
      const ms = performance.now() - start;
      if (response.ok || response.status === 405 || (response.status >= 300 && response.status < 400)) {
        results.push({ ms, ok: true, status: response.status });
      } else {
        results.push({ ms: null, ok: false, status: response.status, error: `http_${response.status}` });
      }
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
  const [analytics, players, internal, json, staticPlayers, loop] = await Promise.all([
    probeAnalyticsStorage(samplesPerTarget),
    probePlayerStorage(samplesPerTarget),
    probeInternalSummary(samplesPerTarget),
    probeUpstream("upstream_json", samplesPerTarget, timeoutMs),
    probeUpstream("upstream_players", samplesPerTarget, timeoutMs),
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
    targets: [analytics, players, internal, json, staticPlayers, loop],
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
