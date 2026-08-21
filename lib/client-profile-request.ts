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

const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 64;
const responseCache = new Map<string, CachedResponse>();
const inFlight = new Map<string, Promise<PlayerProfileJsonResponse<unknown>>>();

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

export function loadPlayerProfileResponse<T>(
  url: string,
  options: { force?: boolean; request?: typeof fetch } = {},
): Promise<PlayerProfileJsonResponse<T>> {
  const key = playerProfileRequestKey(url);
  if (!options.force) {
    const cached = getCachedPlayerProfileResponse<T>(key);
    if (cached) return Promise.resolve(cached);
    const pending = inFlight.get(key);
    if (pending) return pending as Promise<PlayerProfileJsonResponse<T>>;
  }

  const requestKey = options.force ? `${key}\0refresh` : key;
  const existing = inFlight.get(requestKey);
  if (existing) return existing as Promise<PlayerProfileJsonResponse<T>>;

  const request = (options.request ?? fetch)(url, {
    cache: options.force ? "no-store" : "default",
  }).then(async (response) => {
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
  }).finally(() => {
    if (inFlight.get(requestKey) === request) inFlight.delete(requestKey);
  });
  inFlight.set(requestKey, request);
  return request as Promise<PlayerProfileJsonResponse<T>>;
}

export function warmPlayerProfileResponse(url: string): void {
  void loadPlayerProfileResponse(url).catch(() => {
    // The mounted profile owns the visible error state and can retry.
  });
}
