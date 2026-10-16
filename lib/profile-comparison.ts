import type { ProfileComparisonStats } from "../types/profile-view.ts";
import type { ParsedPlayerStats } from "../types/tarkov.ts";
import type { SeasonalProfile } from "../types/seasonal.ts";
import { seasonalKdRatio } from "./seasonal/ui.ts";
import { killedPmcPerRaid } from "./killed-pmc-per-raid.ts";

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function buildPersistentComparisonStats(stats: ParsedPlayerStats): ProfileComparisonStats {
  return {
    hoursPlayed: finiteOrNull(stats.hoursPlayed),
    pmcRaids: finiteOrNull(stats.pmcRaids),
    kdRatio: finiteOrNull(stats.kdRatio),
    pmcKdRatio: stats.pvpStatsKnown === false ? null : finiteOrNull(stats.pmcKdRatio),
    killsPerRaid: finiteOrNull(stats.killsPerRaid),
    killedPmcPerRaid: killedPmcPerRaid(stats),
    pmcSurvivalRate: finiteOrNull(stats.pmcSurvivalRate),
    longestWinStreak: finiteOrNull(stats.longestWinStreak),
    level: finiteOrNull(stats.level),
    pvpStatsKnown: stats.pvpStatsKnown,
  };
}

/** Backward-compatible regular name for callers that only render PvP. */
export function buildRegularComparisonStats(stats: ParsedPlayerStats): ProfileComparisonStats {
  return buildPersistentComparisonStats(stats);
}

export function buildSeasonalComparisonStats(profile: SeasonalProfile): ProfileComparisonStats {
  const stats = profile.seasonalStats;
  const counters = profile.counters;
  return {
    hoursPlayed: finiteOrNull(profile.lifetimePvpHours),
    killedPmcPerRaid: killedPmcPerRaid({ ...counters, pvpStatsVersion: profile.pvpStatsVersion }),
    pmcRaids: finiteOrNull(counters.pmcRaids),
    // One rule with the client view, in seasonalKdRatio. The overview
    // projection in lib/player-profile-view.ts reads stats.kdRatio directly.
    kdRatio: finiteOrNull(seasonalKdRatio(profile.seasonalStats, profile.counters)),
    pmcKdRatio: finiteOrNull(
      stats?.pmcKdRatio ?? (counters.pmcDeaths > 0 ? counters.killedPmc / counters.pmcDeaths : null),
    ),
    killsPerRaid: finiteOrNull(
      stats?.killsPerRaid ?? (counters.pmcRaids > 0 ? counters.pmcKills / counters.pmcRaids : null),
    ),
    pmcSurvivalRate: finiteOrNull(
      stats?.pmcSurvivalRate
        ?? (counters.pmcRaids > 0 ? counters.pmcSurvived / counters.pmcRaids * 100 : null),
    ),
    longestWinStreak: finiteOrNull(
      stats?.longestWinStreak ?? profile.staticSignals?.longestWinStreak,
    ),
    level: finiteOrNull(stats?.level),
  };
}
