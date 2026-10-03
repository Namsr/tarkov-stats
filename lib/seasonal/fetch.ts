import { fetchTarkovJson } from "@/lib/tarkov-api";
import { seasonalUpstreamMode } from "@/lib/seasonal/config";
import { seasonalProfileCacheUrl } from "@/lib/seasonal/profile-cache-key";

export interface SeasonalFetchOptions {
  /** Feed version used to make a CDN/proxy cache key deterministic. */
  expectedUpdatedAt?: number;
  /** Explicit user refresh; bypass the normal fifteen-minute cache slot. */
  force?: boolean;
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

/** Fetches one configured Seasonal profile through the project's JSON helper. */
export async function fetchSeasonalPayload(
  aid: number,
  options: SeasonalFetchOptions = {},
): Promise<unknown> {
  const url = seasonalProfileUrl(aid);
  if (!url) throw new Error("Seasonal upstream endpoint is not configured");
  const request = options.request ?? fetchTarkovJson;
  const response = await request(
    seasonalProfileCacheUrl(url, options.expectedUpdatedAt, Date.now(), options.force),
    { cache: "no-store" },
  );
  if (!response.ok) throw new SeasonalFetchError(response.status);
  return response.json();
}
