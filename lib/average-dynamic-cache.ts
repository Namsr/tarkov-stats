import { readStatisticsResponse, writeStatisticsResponse } from "./average-publication.ts";

const TTL_MS = 15 * 60_000;
// Cohort keys are per-aid (high cardinality) but each entry is a small JSON
// payload, so a 2048-entry LRU bounds memory without evicting hot averages.
const MAX_KEYS = 2048;

const DEFAULT_DYNAMIC_COMPUTE_TIMEOUT_MS = 25_000;

export class DynamicComputeTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`Dynamic average compute timed out after ${timeoutMs}ms`);
    this.name = "DynamicComputeTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

// Read at call time (not import time) so tests and runtime env overrides
// apply per request. Invalid / non-positive values fall back to the default.
function dynamicComputeTimeoutMs(): number {
  const raw = Number(process.env.DYNAMIC_COMPUTE_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_DYNAMIC_COMPUTE_TIMEOUT_MS;
  return Math.floor(raw);
}

// Race a compute promise against the slow-compute budget. The timer is
// cleared on settle and unref'd so it never keeps the process alive.
function withComputeTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DynamicComputeTimeoutError(timeoutMs)), timeoutMs);
    if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
      (timer as unknown as { unref: () => void }).unref();
    }
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

type Saved<T> = { key: string; value: T; generatedAt: number; expiresAt: number };
type Entry<T> = {
  saved?: Saved<T>;
  restoring?: Promise<void>;
  pending?: { key: string; promise: Promise<T> };
  retryAt: number;
  bytes?: number;
};
// Next can bundle this module separately for different route handlers. Share
// the last successful answer and in-flight jobs across those bundles too.
const cacheSymbol: unique symbol = Symbol.for("tarkov.statistics-response-cache.v1");
const cacheGlobal = globalThis as typeof globalThis & { [cacheSymbol]?: Map<string, Entry<unknown>> };
const entries = cacheGlobal[cacheSymbol] ??= new Map<string, Entry<unknown>>();

function boundMemory(): void {
  let bytes = 0;
  for (const entry of entries.values()) bytes += entry.bytes ?? 0;
  for (const [identity, entry] of entries) {
    if (bytes <= 32 * 1024 * 1024 && entries.size <= MAX_KEYS) break;
    entries.delete(identity);
    bytes -= entry.bytes ?? 0;
  }
}

export type StatisticsCacheOptions<T> = {
  // The identity includes every user filter, but excludes scan/revision numbers.
  fallbackKey?: string;
  ttlMs?: number;
  accept?: (value: T) => boolean;
};

export type StatisticsCacheResult<T> = {
  value: T;
  cache: "hit" | "miss";
  stale: boolean;
  generatedAt: number;
};

export function statisticsCacheHeaders(result: { stale: boolean; generatedAt: number }): Record<string, string> {
  return {
    "X-Statistics-Stale": result.stale ? "1" : "0",
    "X-Statistics-Generated-At": String(result.generatedAt),
    // Refresh polling must reach the server rather than replay a browser/CDN copy.
    "Cache-Control": "no-store",
    ...(result.stale ? { "Retry-After": "5" } : {}),
  };
}

export async function loadDynamicAverage<T>(
  key: string,
  load: () => Promise<T>,
  now = Date.now(),
  options: StatisticsCacheOptions<T> = {},
): Promise<StatisticsCacheResult<T>> {
  const identity = `statistics-v1:${options.fallbackKey ?? key}`;
  let entry = entries.get(identity) as Entry<T> | undefined;
  if (!entry) {
    while (entries.size >= MAX_KEYS) entries.delete(entries.keys().next().value!);
    entry = { retryAt: 0 };
    entries.set(identity, entry);
    const target = entry;
    entry.restoring = readStatisticsResponse<Saved<T>>(identity).then((saved) => {
      if (saved && saved.value != null && Number.isFinite(saved.generatedAt) && Number.isFinite(saved.expiresAt)) {
        target.saved = saved;
        target.bytes = Buffer.byteLength(JSON.stringify(saved));
      }
    });
  }
  await entry.restoring;
  entries.delete(identity);
  entries.set(identity, entry);
  boundMemory();
  const saved = entry.saved;
  const fresh = saved && saved.key === key && saved.expiresAt > now;
  if (fresh) return { value: saved.value, cache: "hit", stale: false, generatedAt: saved.generatedAt };

  const shared = entry.pending?.key === key;
  if (!shared && (!saved || entry.retryAt <= now)) {
    const target = entry;
    const started = Date.now();
    // A microtask also catches synchronous loaders. A failed/null response
    // never destroys the last successful one, and a superseded job cannot win.
    const job = { key, promise: null as unknown as Promise<T> };
    target.pending = job;
    // Let the stale HTTP response finish its microtasks before a synchronous
    // SQLite loader starts. Cold requests still await the same bounded job.
    const compute = saved ? new Promise<T>((resolve, reject) => {
      setImmediate(() => { Promise.resolve().then(load).then(resolve, reject); });
    }) : Promise.resolve().then(load);
    job.promise = compute.then(async (value) => {
      const accepted = options.accept ? options.accept(value) : value != null;
      if (accepted && target.pending === job && entries.get(identity) === target) {
        const generatedAt = now + Math.max(0, Date.now() - started);
        const next = { key, value, generatedAt, expiresAt: generatedAt + (options.ttlMs ?? TTL_MS) };
        target.saved = next;
        target.bytes = Buffer.byteLength(JSON.stringify(next));
        boundMemory();
        target.retryAt = 0;
        await writeStatisticsResponse(identity, next, now);
      } else if (!accepted) {
        target.retryAt = now + 5_000;
      }
      return value;
    }).catch((error: unknown) => {
      if (target.pending === job) target.retryAt = now + Math.max(0, Date.now() - started) + 5_000;
      throw error;
    }).finally(() => {
      if (target.pending === job) target.pending = undefined;
    });
    job.promise.catch(() => undefined);
  }
  // The update runs on the long-lived VPS process; cold callers alone await it.
  if (saved) return { value: saved.value, cache: "hit", stale: true, generatedAt: saved.generatedAt };
  try {
    const value = await withComputeTimeout(entry.pending!.promise, dynamicComputeTimeoutMs());
    return { value, cache: shared ? "hit" : "miss", stale: false, generatedAt: entry.saved?.generatedAt ?? now };
  } catch (error) {
    // Computation may have finished just before the deadline while its durable
    // write is still pending. The ready memory answer is already usable.
    if (entry.saved) return { value: entry.saved.value, cache: "hit", stale: entry.saved.key !== key, generatedAt: entry.saved.generatedAt };
    throw error;
  }
}

export function resetDynamicAverageCacheForTests(): void {
  entries.clear();
}
