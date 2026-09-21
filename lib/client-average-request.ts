type CachedJson = { body: unknown; status: number; retryAfter: number };
type NetworkInformation = { saveData?: boolean; effectiveType?: string };

const responses = new Map<string, Promise<CachedJson>>();

interface AverageInFlight {
  promise: Promise<CachedJson>;
  controller: AbortController;
  /** Active demand consumers. Aborting the last one aborts the network. */
  consumers: number;
  /** True while this entry is a best-effort prefetch with no demand owner. */
  prefetch: boolean;
}

const inFlight = new Map<string, AverageInFlight>();
const pendingPrefetches: string[] = [];
let activePrefetches = 0;
let idleScheduled = false;
let idleHandle: number | ReturnType<typeof setTimeout> | null = null;

function fetchJson(url: string, signal?: AbortSignal): Promise<CachedJson> {
  return fetch(url, signal ? { cache: "default", signal } : { cache: "default" }).then(async (response) => {
    const body = await response.json() as unknown;
    const result = {
      body,
      status: response.status,
      retryAfter: Math.max(1, Math.min(15, Number(response.headers.get("retry-after")) || 5)),
    };
    return result;
  });
}

function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Attach a consumer to a shared network request keyed by URL.
 * Aborting one consumer rejects only that consumer; the shared fetch is
 * aborted only when the last demand consumer leaves (prefetch-only entries
 * are owned by the prefetch queue instead).
 */
function attachToShared(entry: AverageInFlight, signal?: AbortSignal): Promise<CachedJson> {
  if (!signal) {
    entry.consumers += 1;
    return entry.promise.then(
      (value) => {
        entry.consumers = Math.max(0, entry.consumers - 1);
        return value;
      },
      (error) => {
        entry.consumers = Math.max(0, entry.consumers - 1);
        throw error;
      },
    );
  }
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  entry.consumers += 1;
  return new Promise<CachedJson>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      entry.consumers = Math.max(0, entry.consumers - 1);
      if (entry.consumers === 0 && !entry.prefetch) {
        try {
          entry.controller.abort();
        } catch {
          // Ignore abort errors during navigation.
        }
      }
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    entry.promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        entry.consumers = Math.max(0, entry.consumers - 1);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        entry.consumers = Math.max(0, entry.consumers - 1);
        reject(error);
      },
    );
  });
}

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

function throwForStatus(response: CachedJson): never {
  const message = typeof response.body === "object" && response.body && "error" in response.body
    ? String((response.body as { error: unknown }).error)
    : `Average request failed (${response.status})`;
  throw new Error(message);
}

export async function loadAverageJson<T>(
  url: string,
  options: { signal?: AbortSignal; retryUnavailable?: boolean } = {},
): Promise<T> {
  const signal = options.signal;
  for (;;) {
    aborted(signal);
    const settled = responses.get(url);
    if (settled) {
      let response: CachedJson;
      try {
        response = await raceWithAbort(settled, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        if (responses.get(url) === settled) responses.delete(url);
        continue;
      }
      aborted(signal);
      if (response.status >= 200 && response.status < 300) return response.body as T;
      if (response.status === 503 && options.retryUnavailable) {
        await wait(response.retryAfter * 1_000, signal);
        continue;
      }
      throwForStatus(response);
    }

    let entry = inFlight.get(url);
    if (!entry) {
      const controller = new AbortController();
      const fresh: AverageInFlight = {
        promise: null as unknown as Promise<CachedJson>,
        controller,
        consumers: 0,
        prefetch: false,
      };
      const network = fetchJson(url, controller.signal).then((result) => {
        if (result.status >= 200 && result.status < 300) {
          responses.set(url, Promise.resolve(result));
        }
        return result;
      });
      fresh.promise = network.finally(() => {
        if (inFlight.get(url) === fresh) inFlight.delete(url);
      });
      // Avoid unhandled rejection when the shared fetch fails before anyone attaches.
      fresh.promise.catch(() => undefined);
      inFlight.set(url, fresh);
      entry = fresh;
    } else if (entry.prefetch) {
      // A demand request takes over a best-effort prefetch so a later
      // cancelAveragePrefetches() no longer aborts it.
      entry.prefetch = false;
    }

    let response: CachedJson;
    try {
      response = await attachToShared(entry, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      // The shared network was aborted underneath us while our signal is
      // still alive (last consumer left or test reset): retry with a fresh fetch.
      if (entry.controller.signal.aborted) continue;
      throw error;
    }
    aborted(signal);
    if (response.status >= 200 && response.status < 300) return response.body as T;
    if (response.status === 503 && options.retryUnavailable) {
      await wait(response.retryAfter * 1_000, signal);
      continue;
    }
    throwForStatus(response);
  }
}

function permitsPrefetch(): boolean {
  if (typeof navigator === "undefined") return false;
  const connection = (navigator as Navigator & { connection?: NetworkInformation }).connection;
  return connection?.saveData !== true && !["slow-2g", "2g"].includes(connection?.effectiveType ?? "");
}

function drainPrefetchQueue(): void {
  while (activePrefetches < 2 && pendingPrefetches.length > 0) {
    const url = pendingPrefetches.shift()!;
    if (responses.has(url) || inFlight.has(url)) continue;
    const controller = new AbortController();
    const entry: AverageInFlight = {
      promise: null as unknown as Promise<CachedJson>,
      controller,
      consumers: 0,
      prefetch: true,
    };
    const network = fetchJson(url, controller.signal).then((result) => {
      if (!controller.signal.aborted && result.status >= 200 && result.status < 300) {
        responses.set(url, Promise.resolve(result));
      }
      return result;
    });
    entry.promise = network.finally(() => {
      if (inFlight.get(url) === entry) inFlight.delete(url);
      activePrefetches = Math.max(0, activePrefetches - 1);
      drainPrefetchQueue();
    });
    // Best-effort: a failed prefetch must not surface as an unhandled rejection.
    // Demand consumers that later take over still observe the rejection via attach.
    entry.promise.catch(() => undefined);
    inFlight.set(url, entry);
    activePrefetches += 1;
  }
}

export function scheduleAveragePrefetch(urls: readonly string[]): void {
  if (!permitsPrefetch()) return;
  for (const url of urls) {
    if (!responses.has(url) && !inFlight.has(url) && !pendingPrefetches.includes(url)) {
      pendingPrefetches.push(url);
    }
  }
  if (idleScheduled) return;
  idleScheduled = true;
  const start = () => {
    idleScheduled = false;
    idleHandle = null;
    drainPrefetchQueue();
  };
  if ("requestIdleCallback" in window) {
    const requestIdle = (window as Window & {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }).requestIdleCallback;
    if (typeof requestIdle === "function") {
      idleHandle = requestIdle.call(window, start, { timeout: 2_000 });
    } else {
      idleHandle = globalThis.setTimeout(start, 250);
    }
  } else {
    idleHandle = globalThis.setTimeout(start, 250);
  }
}

/**
 * Cancel best-effort average prefetches.
 *
 * Prefetch is best-effort: entries already taken over by a demand
 * `loadAverageJson` call (`prefetch === false`) are never aborted here, so an
 * `AveragePageHeader` unmount cannot cancel a fetch that `ArenaAverage` (or
 * the average page) is already awaiting. When `urls` is provided only those
 * keys are cancelled; otherwise every prefetch-only entry is cancelled.
 */
export function cancelAveragePrefetches(urls?: readonly string[]): void {
  const targets = urls === undefined ? null : new Set(urls);
  if (targets === null) {
    pendingPrefetches.splice(0);
  } else {
    for (let index = pendingPrefetches.length - 1; index >= 0; index -= 1) {
      if (targets.has(pendingPrefetches[index])) pendingPrefetches.splice(index, 1);
    }
  }
  if (pendingPrefetches.length === 0 && idleScheduled) {
    idleScheduled = false;
    if (idleHandle !== null) {
      try {
        const w = typeof window !== "undefined"
          ? (window as Window & { cancelIdleCallback?: (h: number) => void })
          : undefined;
        if (w && typeof w.cancelIdleCallback === "function" && typeof idleHandle === "number") {
          w.cancelIdleCallback(idleHandle);
        } else {
          clearTimeout(idleHandle as ReturnType<typeof setTimeout>);
        }
      } catch {
        // Ignore cleanup errors during navigation.
      }
      idleHandle = null;
    }
  }
  for (const [url, entry] of Array.from(inFlight)) {
    if (!entry.prefetch) continue;
    if (targets !== null && !targets.has(url)) continue;
    try {
      entry.controller.abort();
    } catch {
      // Ignore abort errors during navigation.
    }
    if (inFlight.get(url) === entry) inFlight.delete(url);
  }
}

export function resetAverageResponseCacheForTests(): void {
  try {
    cancelAveragePrefetches();
  } catch {
    // Ignore cleanup errors in test fixtures without full window surface.
  }
  for (const [, entry] of Array.from(inFlight)) {
    try {
      entry.controller.abort();
    } catch {
      // Ignore abort errors in test fixtures.
    }
  }
  responses.clear();
  inFlight.clear();
  pendingPrefetches.splice(0);
  activePrefetches = 0;
  idleScheduled = false;
  idleHandle = null;
}
