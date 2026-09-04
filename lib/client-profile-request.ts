"use client";

export interface PlayerProfileJsonResponse<T> {
  ok: boolean;
  status: number;
  body: T;
}

interface CachedResponse {
  expiresAt: number;
  response: PlayerProfileJsonResponse<unknown>;
}

interface ProfileInFlight {
  promise: Promise<PlayerProfileJsonResponse<unknown>>;
  controller: AbortController;
  consumers: number;
}

const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 64;
const responseCache = new Map<string, CachedResponse>();
const inFlight = new Map<string, ProfileInFlight>();

export class PlayerProfileResponseError extends Error {
  constructor() {
    super("Invalid player profile response");
    this.name = "PlayerProfileResponseError";
  }
}

export function playerProfileRequestKey(url: string): string {
  const parsed = new URL(url, "http://local");
  if (parsed.pathname !== "/api/player/profile") return url;
  const mode = parsed.searchParams.get("mode") || "regular";
  parsed.searchParams.delete("refresh");
  if (mode !== "seasonal") parsed.searchParams.delete("cycle");
  parsed.searchParams.sort();
  const query = parsed.searchParams.toString();
  return `${parsed.pathname}${query ? `?${query}` : ""}`;
}

export function getCachedPlayerProfileResponse<T>(url: string): PlayerProfileJsonResponse<T> | null {
  const key = playerProfileRequestKey(url);
  const cached = responseCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    responseCache.delete(key);
    return null;
  }
  return cached.response as PlayerProfileJsonResponse<T>;
}

function cacheResponse(key: string, response: PlayerProfileJsonResponse<unknown>): void {
  if (!response.ok) return;
  if (responseCache.size >= CACHE_MAX && !responseCache.has(key)) {
    responseCache.delete(responseCache.keys().next().value as string);
  }
  responseCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, response });
}

/**
 * Attach a consumer to a shared profile request keyed by URL.
 * Aborting one consumer rejects only that consumer; the shared network is
 * aborted only when the last consumer leaves.
 */
function attachProfile(
  entry: ProfileInFlight,
  signal?: AbortSignal,
): Promise<PlayerProfileJsonResponse<unknown>> {
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
  return new Promise<PlayerProfileJsonResponse<unknown>>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      entry.consumers = Math.max(0, entry.consumers - 1);
      if (entry.consumers === 0) {
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

async function parseProfileResponse(
  response: Response,
  key: string,
): Promise<PlayerProfileJsonResponse<unknown>> {
  const text = await response.text();
  if (!text.trim()) throw new PlayerProfileResponseError();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new PlayerProfileResponseError();
  }
  const result = { ok: response.ok, status: response.status, body };
  cacheResponse(key, result);
  return result;
}

export function loadPlayerProfileResponse<T>(
  url: string,
  options: { force?: boolean; request?: typeof fetch; signal?: AbortSignal } = {},
): Promise<PlayerProfileJsonResponse<T>> {
  const key = playerProfileRequestKey(url);
  const signal = options.signal;
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  if (!options.force) {
    const cached = getCachedPlayerProfileResponse<T>(key);
    if (cached) return Promise.resolve(cached);
  }

  const requestKey = options.force ? `${key}\0refresh` : key;
  const existing = inFlight.get(requestKey);
  if (existing) {
    return attachProfile(existing, signal) as Promise<PlayerProfileJsonResponse<T>>;
  }

  const controller = new AbortController();
  const doFetch = options.request ?? fetch;
  const network = doFetch(url, {
    cache: options.force ? "no-store" : "default",
    signal: controller.signal,
  }).then((response) => parseProfileResponse(response, key));
  const entry: ProfileInFlight = {
    promise: null as unknown as Promise<PlayerProfileJsonResponse<unknown>>,
    controller,
    consumers: 0,
  };
  entry.promise = network.finally(() => {
    if (inFlight.get(requestKey) === entry) inFlight.delete(requestKey);
  });
  // Avoid unhandled rejection when the shared fetch fails before anyone attaches.
  entry.promise.catch(() => undefined);
  inFlight.set(requestKey, entry);
  return attachProfile(entry, signal) as Promise<PlayerProfileJsonResponse<T>>;
}

export function warmPlayerProfileResponse(url: string, signal?: AbortSignal): void {
  void loadPlayerProfileResponse(url, signal ? { signal } : undefined).catch(() => {
    // The mounted profile owns the visible error state and can retry.
  });
}
