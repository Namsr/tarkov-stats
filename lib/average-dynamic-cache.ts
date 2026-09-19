// 15min TTL is safe because per-aid cohort keys fan out behind a 30-min
// unstable_cache layer, and entries are small JSON (bounded LRU below).
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

type Entry<T> = { promise: Promise<T>; expiresAt: number };
const entries = new Map<string, Entry<unknown>>();

function prune(now: number): void {
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= now) entries.delete(key);
  }
  while (entries.size >= MAX_KEYS) entries.delete(entries.keys().next().value!);
}

export async function loadDynamicAverage<T>(
  key: string,
  load: () => Promise<T>,
  now = Date.now(),
): Promise<{ value: T; cache: "hit" | "miss" }> {
  // Slow-compute guard lives here so every caller (average + cohort routes)
  // shares it. Callers already map any error to 500/503, which covers
  // DynamicComputeTimeoutError without route changes.
  const timeoutMs = dynamicComputeTimeoutMs();
  const existing = entries.get(key) as Entry<T> | undefined;
  if (existing && existing.expiresAt > now) {
    entries.delete(key);
    entries.set(key, existing);
    try {
      return { value: await withComputeTimeout(existing.promise, timeoutMs), cache: "hit" };
    } catch (error) {
      // Timeout keeps the in-flight entry so its late result still warms the
      // cache; a real failure evicts so the next caller retries.
      if (error instanceof DynamicComputeTimeoutError) throw error;
      if (entries.get(key) === (existing as unknown as Entry<unknown>)) entries.delete(key);
      throw error;
    }
  }
  prune(now);
  let compute: Promise<T>;
  try {
    compute = load();
  } catch (error) {
    // Synchronous throw: nothing was cached, just propagate.
    throw error;
  }
  const entry: Entry<T> = {
    promise: compute,
    expiresAt: now + TTL_MS,
  };
  entries.set(key, entry);
  // If the awaiting caller times out first, this late-rejection handler evicts
  // the entry so a rejected promise is never stuck in the cache until TTL, and
  // it marks the original promise handled (no unhandled rejection). A late
  // success intentionally stays cached to warm the next caller.
  compute.then(undefined, () => {
    if (entries.get(key) === (entry as unknown as Entry<unknown>)) entries.delete(key);
  });
  try {
    return { value: await withComputeTimeout(entry.promise, timeoutMs), cache: "miss" };
  } catch (error) {
    // Timeout: keep the original entry cached for background warming.
    // Normal compute error: evict the entry, rethrow (existing behavior).
    if (error instanceof DynamicComputeTimeoutError) throw error;
    if (entries.get(key) === (entry as unknown as Entry<unknown>)) entries.delete(key);
    throw error;
  }
}

export function resetDynamicAverageCacheForTests(): void {
  entries.clear();
}
