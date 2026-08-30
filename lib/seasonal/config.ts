import type { SeasonCycle, SeasonalCollectionSource } from "../../types/seasonal";

type Environment = Record<string, string | undefined>;

function timestamp(value: string | undefined): number | null {
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 1_000_000_000_000 ? Math.round(numeric * 1_000) : Math.round(numeric);
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function seasonalCollectionSource(
  value: string | undefined,
): SeasonalCollectionSource | null {
  if (value == null || value.trim() === "") return "operator";
  if (value === "operator" || value === "json_feed") return value;
  return null;
}

function tarkovStaticUrl(value: string | undefined, expectedPath?: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "players.tarkov.dev" ||
      url.username !== "" ||
      url.password !== ""
    ) return false;
    if (expectedPath === undefined) return true;
    const pathname = url.pathname.replace(/\/+$/, "");
    return pathname === `/${expectedPath}` || pathname.endsWith(`/${expectedPath}`);
  } catch {
    return false;
  }
}

function seasonalProfileContract(
  env: Environment,
  configured: SeasonCycle["upstreamContract"],
): SeasonCycle["upstreamContract"] {
  const template = env.SEASONAL_PROFILE_URL_TEMPLATE;
  if (!template) return configured;
  try {
    const url = new URL(template
      .replaceAll("{mode}", seasonalUpstreamMode())
      .replaceAll("{aid}", "1"));
    return url.protocol === "https:" &&
      url.hostname === "players.tarkov.dev" &&
      url.pathname === "/pvp-season/1.json" &&
      url.search === "" &&
      url.hash === "" &&
      url.username === "" &&
      url.password === ""
      ? "direct_profile"
      : configured;
  } catch {
    return configured;
  }
}

/**
 * Reads the one active Seasonal cycle. Invalid or incomplete configuration is
 * deliberately fail-closed, so neither capture nor UI can turn on early.
 */
export function loadSeasonalCycleConfig(env: Environment = process.env): SeasonCycle | null {
  const rawCycleId = env.SEASONAL_CYCLE_ID?.trim() ?? "";
  const cycleId = /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(rawCycleId) ? rawCycleId : null;
  const startsAt = timestamp(env.SEASONAL_STARTS_AT);
  const endsAt = timestamp(env.SEASONAL_ENDS_AT);
  const contract = env.SEASONAL_UPSTREAM_CONTRACT;
  const collectionSource = seasonalCollectionSource(env.SEASONAL_COLLECTION_SOURCE);
  if (
    cycleId === null ||
    startsAt === null ||
    (env.SEASONAL_ENDS_AT && endsAt === null) ||
    (endsAt !== null && endsAt <= startsAt) ||
    collectionSource === null ||
    (contract !== "game_mode" && contract !== "profile_section" && contract !== "direct_profile")
  ) {
    return null;
  }
  return {
    mode: "seasonal",
    cycleId,
    startsAt,
    endsAt,
    enabled: env.SEASONAL_ENABLED === "true",
    upstreamContract: seasonalProfileContract(env, contract),
    collectionSource,
  };
}

export function isSeasonalRolloutReady(env: Environment = process.env): boolean {
  const template = env.SEASONAL_PROFILE_URL_TEMPLATE;
  const cycle = loadSeasonalCycleConfig(env);
  if (cycle?.enabled !== true || !template || !template.includes("{aid}")) {
    return false;
  }
  try {
    const url = new URL(template.replaceAll("{mode}", seasonalUpstreamMode()).replaceAll("{aid}", "1"));
    if (
      url.protocol !== "https:" ||
      url.hostname !== "players.tarkov.dev" ||
      url.username !== "" ||
      url.password !== ""
    ) return false;
    if (cycle.collectionSource === "json_feed") {
      return isSeasonalCollectorReady(env);
    }
    return true;
  } catch {
    return false;
  }
}

/** JSON collection can warm storage before Seasonal is exposed publicly. */
export function isSeasonalCollectorReady(
  env: Environment = process.env,
  now = Date.now(),
): boolean {
  const cycle = loadSeasonalCycleConfig(env);
  const template = env.SEASONAL_PROFILE_URL_TEMPLATE;
  if (
    cycle?.collectionSource !== "json_feed" ||
    env.SEASONAL_UPSTREAM_FIXTURE_CONFIRMED !== "true" ||
    cycle.startsAt > now ||
    (cycle.endsAt !== null && cycle.endsAt < now) ||
    !template ||
    !template.includes("{aid}") ||
    !tarkovStaticUrl(env.SEASONAL_PROFILE_UPDATED_URL, "updated.json") ||
    !tarkovStaticUrl(env.SEASONAL_PROFILE_INDEX_URL, "index.json")
  ) return false;
  try {
    const url = new URL(template.replaceAll("{mode}", seasonalUpstreamMode()).replaceAll("{aid}", "1"));
    return url.protocol === "https:" && url.hostname === "players.tarkov.dev" &&
      url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

/**
 * External mode slug used only at the Tarkov.dev boundary. The rest of the
 * application intentionally continues to use the internal `seasonal` mode.
 */
export function seasonalUpstreamMode(): "pvp-season" {
  return "pvp-season";
}

export function isCommunityReviewEnabled(env: Environment = process.env): boolean {
  return env.COMMUNITY_REVIEW_ENABLED === "true" &&
    (env.HELPER_COOKIE_SECRET?.trim().length ?? 0) >= 32;
}

export function isCommunityHelperEnabled(env: Environment = process.env): boolean {
  return loadSeasonalCycleConfig(env)?.collectionSource !== "json_feed" &&
    isSeasonalRolloutReady(env) &&
    env.COMMUNITY_HELPER_ENABLED === "true" &&
    (env.HELPER_COOKIE_SECRET?.trim().length ?? 0) >= 32;
}
