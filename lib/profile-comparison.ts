import type { ProfileComparisonStats } from "../types/profile-view.ts";
import type { ParsedPlayerStats } from "../types/tarkov.ts";
import type { SeasonalProfile } from "../types/seasonal.ts";

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
    pmcRaids: finiteOrNull(counters.pmcRaids),
    // Derive only when there are no Seasonal stats at all. stats.kdRatio is
    // totalKills / deaths with both spanning PMC+Scav, and it is null exactly
    // when the Scav side is incomplete. Any fallback built from the counters
    // would divide a total by a subset, or quietly relabel a PMC-only ratio as
    // the total one. Matches the overview projection in lib/player-profile-view.ts.
    kdRatio: finiteOrNull(
      stats
        ? stats.kdRatio
        : (counters.pmcDeaths > 0 ? counters.pmcKills / counters.pmcDeaths : null),
    ),
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
