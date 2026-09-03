type CachedJson = { body: unknown; status: number; retryAfter: number };
type NetworkInformation = { saveData?: boolean; effectiveType?: string };

const responses = new Map<string, Promise<CachedJson>>();
const pendingPrefetches: string[] = [];
const prefetchControllers = new Map<string, AbortController>();
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

function request(url: string): Promise<CachedJson> {
  const existing = responses.get(url);
  if (existing) return existing;
  const promise = fetchJson(url).then((result) => {
    if (!result.status || result.status < 200 || result.status >= 300) responses.delete(url);
    return result;
  }).catch((error) => {
    responses.delete(url);
    throw error;
  });
  responses.set(url, promise);
  return promise;
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

export async function loadAverageJson<T>(
  url: string,
  options: { signal?: AbortSignal; retryUnavailable?: boolean } = {},
): Promise<T> {
  const signal = options.signal;
  for (;;) {
    aborted(signal);
    let response!: CachedJson;
    if (signal) {
      const shared = responses.get(url);
      if (shared) {
        try {
          response = await raceWithAbort(shared, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          // Shared prefetch was cancelled or failed while our signal is still
          // alive: fall through to a dedicated abortable request below.
          if (responses.has(url)) continue;
          try {
            response = await fetchJson(url, signal);
          } catch (dedicatedError) {
            if (signal.aborted) throw dedicatedError;
            throw dedicatedError;
          }
        }
      } else {
        try {
          response = await fetchJson(url, signal);
        } catch (error) {
          // fetch() rejects with AbortError when signal aborts the network.
          throw error;
        }
        if (response.status >= 200 && response.status < 300) {
          responses.set(url, Promise.resolve(response));
        }
      }
    } else {
      response = await request(url);
    }
    aborted(signal);
    if (response.status >= 200 && response.status < 300) return response.body as T;
    if (response.status === 503 && options.retryUnavailable) {
      await wait(response.retryAfter * 1_000, options.signal);
      continue;
    }
    const message = typeof response.body === "object" && response.body && "error" in response.body
      ? String((response.body as { error: unknown }).error)
      : `Average request failed (${response.status})`;
    throw new Error(message);
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
    if (responses.has(url) || prefetchControllers.has(url)) continue;
    const controller = new AbortController();
    prefetchControllers.set(url, controller);
    activePrefetches += 1;
    void fetchJson(url, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.status >= 200 && result.status < 300) {
        responses.set(url, Promise.resolve(result));
      }
    }).catch(() => undefined).finally(() => {
      if (prefetchControllers.get(url) === controller) prefetchControllers.delete(url);
      activePrefetches = Math.max(0, activePrefetches - 1);
      drainPrefetchQueue();
    });
  }
}

export function scheduleAveragePrefetch(urls: readonly string[]): void {
  if (!permitsPrefetch()) return;
  for (const url of urls) {
    if (!responses.has(url) && !pendingPrefetches.includes(url) && !prefetchControllers.has(url)) {
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

export function cancelAveragePrefetches(): void {
  pendingPrefetches.splice(0);
  if (idleScheduled) {
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
  for (const [, controller] of Array.from(prefetchControllers)) {
    try {
      controller.abort();
    } catch {
      // Ignore abort errors during navigation.
    }
  }
  prefetchControllers.clear();
}

export function resetAverageResponseCacheForTests(): void {
  try {
    cancelAveragePrefetches();
  } catch {
    // Ignore cleanup errors in test fixtures without full window surface.
  }
  responses.clear();
  pendingPrefetches.splice(0);
  prefetchControllers.clear();
  activePrefetches = 0;
  idleScheduled = false;
  idleHandle = null;
}
