import { fetchTarkovJson } from "@/lib/tarkov-api";
import { seasonalCollectionSource, seasonalUpstreamMode } from "@/lib/seasonal/config";

export interface SeasonalFetchOptions {
  /** Feed version used to make a CDN/proxy cache key deterministic. */
  expectedUpdatedAt?: number;
  request?: typeof fetchTarkovJson;
}

export class SeasonalFetchError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Seasonal upstream failed: ${status}`);
    this.name = "SeasonalFetchError";
    this.status = status;
  }
}

/** The real endpoint is configured only after the upstream fixture is confirmed. */
export function seasonalProfileUrl(aid: number, template = process.env.SEASONAL_PROFILE_URL_TEMPLATE): string | null {
  if (!Number.isSafeInteger(aid) || aid <= 0 || !template || !template.includes("{aid}")) return null;
  const value = template
    .replaceAll("{mode}", seasonalUpstreamMode())
    .replaceAll("{aid}", String(aid));
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "players.tarkov.dev" &&
      url.username === "" && url.password === "" ? url.toString() : null;
  } catch {
    return null;
  }
}

function addVersionCacheKey(url: string, expectedUpdatedAt: number | undefined): string {
  if (typeof expectedUpdatedAt !== "number" || !Number.isSafeInteger(expectedUpdatedAt) || expectedUpdatedAt <= 0) return url;
  const version = Number(expectedUpdatedAt);
  const parsed = new URL(url);
  parsed.searchParams.set("v", String(version));
  return parsed.toString();
}

/** Fetches one configured Seasonal profile through the project's JSON helper. */
export async function fetchSeasonalPayload(
  aid: number,
  options: SeasonalFetchOptions = {},
): Promise<unknown> {
  const url = seasonalProfileUrl(aid);
  if (!url) throw new Error("Seasonal upstream endpoint is not configured");
  const request = options.request ?? fetchTarkovJson;
  const response = await request(addVersionCacheKey(url, options.expectedUpdatedAt), { cache: "no-store" });
  if (!response.ok) throw new SeasonalFetchError(response.status);
  return response.json();
}

export function seasonalFeedUrls(env: Record<string, string | undefined> = process.env) {
  if (seasonalCollectionSource(env.SEASONAL_COLLECTION_SOURCE) !== "json_feed") return null;
  const updated = env.SEASONAL_PROFILE_UPDATED_URL?.trim() || null;
  const index = env.SEASONAL_PROFILE_INDEX_URL?.trim() || null;
  if (!updated || !index) return null;
  try {
    const urls = [
      new URL(updated.replaceAll("{mode}", seasonalUpstreamMode())),
      new URL(index.replaceAll("{mode}", seasonalUpstreamMode())),
    ];
    if (urls.some((url) =>
      url.protocol !== "https:" || url.hostname !== "players.tarkov.dev" ||
      url.username !== "" || url.password !== "")) return null;
    return { updated: urls[0].toString(), index: urls[1].toString() };
  } catch {
    return null;
  }
}

/** Fetches the version map without bypassing the common Tarkov JSON helper. */
export async function fetchSeasonalUpdatedFeed(
  env: Record<string, string | undefined> = process.env,
  request: typeof fetchTarkovJson = fetchTarkovJson,
): Promise<unknown> {
  const urls = seasonalFeedUrls(env);
  if (!urls) throw new Error("Seasonal JSON feed is not configured");
  const response = await request(urls.updated, { cache: "no-store" });
  if (!response.ok) throw new Error(`Seasonal updated feed failed: ${response.status}`);
  return response.json();
}

/** Fetches the optional daily index through the same JSON-only boundary. */
export async function fetchSeasonalIndex(
  env: Record<string, string | undefined> = process.env,
  request: typeof fetchTarkovJson = fetchTarkovJson,
): Promise<unknown> {
  const urls = seasonalFeedUrls(env);
  if (!urls) throw new Error("Seasonal JSON feed is not configured");
  const response = await request(urls.index, { cache: "no-store" });
  if (!response.ok) throw new Error(`Seasonal index failed: ${response.status}`);
  return response.json();
}
