import type { SeasonCycle } from "@/types/seasonal";

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
  if (
    cycleId === null ||
    startsAt === null ||
    (env.SEASONAL_ENDS_AT && endsAt === null) ||
    (endsAt !== null && endsAt <= startsAt) ||
    (contract !== "game_mode" && contract !== "profile_section")
  ) {
    return null;
  }
  return {
    mode: "seasonal",
    cycleId,
    startsAt,
    endsAt,
    enabled: env.SEASONAL_ENABLED === "true",
    upstreamContract: contract,
  };
}

export function isSeasonalRolloutReady(env: Environment = process.env): boolean {
  const template = env.SEASONAL_PROFILE_URL_TEMPLATE;
  if (loadSeasonalCycleConfig(env)?.enabled !== true || !template || !template.includes("{aid}")) {
    return false;
  }
  try {
    const url = new URL(template.replaceAll("{aid}", "1"));
    return url.protocol === "https:" && url.hostname === "players.tarkov.dev";
  } catch {
    return false;
  }
}

export function isCommunityReviewEnabled(env: Environment = process.env): boolean {
  return env.COMMUNITY_REVIEW_ENABLED === "true" &&
    (env.HELPER_COOKIE_SECRET?.trim().length ?? 0) >= 32;
}

export function isCommunityHelperEnabled(env: Environment = process.env): boolean {
  return isSeasonalRolloutReady(env) &&
    env.COMMUNITY_HELPER_ENABLED === "true" &&
    (env.HELPER_COOKIE_SECRET?.trim().length ?? 0) >= 32;
}
