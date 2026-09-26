import { ARENA_ADDITIVE_COUNTER_KEYS, ARENA_MODE_KEYS, type ArenaCounters, type ArenaModeKey, type ArenaProfile } from "@/types/arena";

export const ARENA_TSR_VERSION = "0.1";
export const ARENA_TSR_WEIGHTS = {
  kd_ratio: 0.35,
  kills_per_match: 0.25,
  damage_per_match: 0.20,
  win_rate: 0.20,
} as const;
export const ARENA_TSR_MIN_MATCHES = 1;
export const ARENA_TSR_ESTABLISHED_MATCHES = 50;
const PRIOR_MATCHES = 30;
const MIN_REFERENCE_PLAYERS = 200;

type RatingMetric = keyof typeof ARENA_TSR_WEIGHTS;
const METRICS = Object.keys(ARENA_TSR_WEIGHTS) as RatingMetric[];
type Contributions = Record<RatingMetric, number>;
export interface ArenaTsReference {
  version: string;
  modes: Record<ArenaModeKey, { metrics: Record<RatingMetric, { value: number | null; count: number }> }>;
}
type RatingReason = "missing_counters" | "inconsistent_results" | "no_matches" | "insufficient_reference" | "incomplete_coverage";
export interface ArenaModeTsRating {
  rating: number | null;
  matches: number | null;
  displayReady: boolean;
  provisional: boolean;
  reason: RatingReason | null;
  contributions: Contributions | null;
}
export interface ArenaTsRating {
  version: string;
  referenceVersion: string;
  overall: ArenaModeTsRating & { complete: boolean; ratedMatches: number };
  modes: Record<ArenaModeKey, ArenaModeTsRating>;
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function unavailable(matches: number | null, reason: RatingReason): ArenaModeTsRating {
  return { rating: null, matches, displayReady: false, provisional: true, reason, contributions: null };
}

/** Cumulative counters from one profile period; no playtime, HS or ARP bonus. */
export function rateArenaMode(counters: ArenaCounters, reference: ArenaTsReference["modes"][ArenaModeKey]): ArenaModeTsRating {
  const { matches, kills, deaths, wins, losses, damage } = counters;
  if (!count(matches) || !count(kills) || !count(deaths) || !count(wins) || !nonNegative(damage)) {
    return unavailable(count(matches) ? matches : null, "missing_counters");
  }
  // Zero matches is only believable when every additive counter is zero too. Any
  // non-zero kill, assist or MVP count alongside matches === 0 is contradictory
  // upstream data, and reporting it as no_matches would hide a played mode. The
  // list is the parser's own additive set, so the two cannot drift apart.
  if (matches === 0) {
    return unavailable(0, ARENA_ADDITIVE_COUNTER_KEYS.some((key) => counters[key] != null && counters[key] !== 0)
      ? "inconsistent_results" : "no_matches");
  }
  if (wins > matches || (losses != null && (!count(losses) || wins + losses > matches))) {
    return unavailable(matches, "inconsistent_results");
  }
  const base = {} as Contributions;
  for (const metric of METRICS) {
    const entry = reference?.metrics[metric];
    if (!entry || !nonNegative(entry.value) || entry.value === 0 || !count(entry.count) || entry.count < MIN_REFERENCE_PLAYERS) {
      return unavailable(matches, "insufficient_reference");
    }
    base[metric] = entry.value;
  }
  if (base.win_rate > 100) return unavailable(matches, "insufficient_reference");
  // Marginal medians define a synthetic baseline, not a rating percentile.
  const adjustedKills = kills + PRIOR_MATCHES * base.kills_per_match;
  const adjustedDeaths = deaths + PRIOR_MATCHES * base.kills_per_match / base.kd_ratio;
  const adjustedMatches = matches + PRIOR_MATCHES;
  const adjusted: Contributions = {
    kd_ratio: adjustedKills / adjustedDeaths,
    kills_per_match: adjustedKills / adjustedMatches,
    damage_per_match: (damage + PRIOR_MATCHES * base.damage_per_match) / adjustedMatches,
    win_rate: (100 * wins + PRIOR_MATCHES * base.win_rate) / adjustedMatches,
  };
  if (!Object.values(adjusted).every(nonNegative)) return unavailable(matches, "missing_counters");
  const contributions = Object.fromEntries(METRICS.map((metric) => [
    metric, 0.5 * ARENA_TSR_WEIGHTS[metric] * Math.log2(Math.max(0.25, Math.min(4, adjusted[metric] / base[metric]))),
  ])) as Contributions;
  return {
    rating: Math.max(0, Math.min(2, 1 + Object.values(contributions).reduce((sum, value) => sum + value, 0))),
    matches, contributions, reason: null,
    displayReady: matches >= ARENA_TSR_MIN_MATCHES,
    provisional: matches < ARENA_TSR_ESTABLISHED_MATCHES,
  };
}

/** Normalize each mode first, then weight by matches. Never silently omit a played mode. */
export function rateArena(profile: ArenaProfile, reference: ArenaTsReference): ArenaTsRating {
  const modes = Object.fromEntries(ARENA_MODE_KEYS.map((mode) => [
    mode, rateArenaMode(profile.modes[mode].counters, reference.modes[mode]),
  ])) as ArenaTsRating["modes"];
  const items = Object.values(modes);
  const total = profile.overall.counters.matches;
  const observed = items.reduce((sum, item) => sum + (item.matches ?? 0), 0);
  const rated = items.filter((item) => item.rating != null);
  const ratedMatches = rated.reduce((sum, item) => sum + (item.matches ?? 0), 0);
  // A mode counts as covered only when it produced a rating or is genuinely
  // unplayed. A contradictory mode must not pass as covered just because its
  // matches field is a number, otherwise the overall rating drops it silently.
  const complete = items.every((item) => item.rating != null || item.reason === "no_matches") && count(total) && total === observed && observed === ratedMatches;
  let overall = unavailable(count(total) ? total : null, ratedMatches === 0 && total === 0 ? "no_matches" : "incomplete_coverage");
  if (complete && ratedMatches > 0) {
    const contributions = Object.fromEntries(METRICS.map((metric) => [metric,
      rated.reduce((sum, item) => sum + item.matches! * item.contributions![metric], 0) / ratedMatches,
    ])) as Contributions;
    overall = {
      rating: rated.reduce((sum, item) => sum + item.matches! * item.rating!, 0) / ratedMatches,
      matches: total, contributions, reason: null,
      displayReady: ratedMatches >= ARENA_TSR_MIN_MATCHES,
      provisional: ratedMatches < ARENA_TSR_ESTABLISHED_MATCHES,
    };
  }
  return { version: ARENA_TSR_VERSION, referenceVersion: reference.version, overall: { ...overall, complete, ratedMatches }, modes };
}
