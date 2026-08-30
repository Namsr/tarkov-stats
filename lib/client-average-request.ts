type CachedJson = { body: unknown; status: number; retryAfter: number };
type NetworkInformation = { saveData?: boolean; effectiveType?: string };

const responses = new Map<string, Promise<CachedJson>>();
const pendingPrefetches: string[] = [];
let activePrefetches = 0;
let idleScheduled = false;

function request(url: string): Promise<CachedJson> {
  const existing = responses.get(url);
  if (existing) return existing;
  const promise = fetch(url, { cache: "default" }).then(async (response) => {
    const body = await response.json() as unknown;
    const result = {
      body,
      status: response.status,
      retryAfter: Math.max(1, Math.min(15, Number(response.headers.get("retry-after")) || 5)),
    };
    if (!response.ok) responses.delete(url);
    return result;
  }).catch((error) => {
    responses.delete(url);
    throw error;
  });
  responses.set(url, promise);
  return promise;
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
  for (;;) {
    aborted(options.signal);
    const response = await request(url);
    aborted(options.signal);
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
    if (responses.has(url)) continue;
    activePrefetches += 1;
    void loadAverageJson(url).catch(() => undefined).finally(() => {
      activePrefetches -= 1;
      drainPrefetchQueue();
    });
  }
}

export function scheduleAveragePrefetch(urls: readonly string[]): void {
  if (!permitsPrefetch()) return;
  for (const url of urls) {
    if (!responses.has(url) && !pendingPrefetches.includes(url)) pendingPrefetches.push(url);
  }
  if (idleScheduled) return;
  idleScheduled = true;
  const start = () => {
    idleScheduled = false;
    drainPrefetchQueue();
  };
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(start, { timeout: 2_000 });
  } else {
    globalThis.setTimeout(start, 250);
  }
}

export function resetAverageResponseCacheForTests(): void {
  responses.clear();
  pendingPrefetches.splice(0);
  activePrefetches = 0;
  idleScheduled = false;
}
