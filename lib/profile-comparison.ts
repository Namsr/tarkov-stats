import type { ProfileComparisonStats } from "../types/profile-view.ts";
import type { ParsedPlayerStats } from "../types/tarkov.ts";
import type { SeasonalProfile } from "../types/seasonal.ts";

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function buildRegularComparisonStats(stats: ParsedPlayerStats): ProfileComparisonStats {
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

export function buildSeasonalComparisonStats(profile: SeasonalProfile): ProfileComparisonStats {
  const stats = profile.seasonalStats;
  const counters = profile.counters;
  const totalKills = stats?.totalKills ?? counters.pmcKills;
  const deaths = stats?.deaths ?? counters.pmcDeaths;
  return {
    hoursPlayed: finiteOrNull(profile.lifetimePvpHours),
    pmcRaids: finiteOrNull(counters.pmcRaids),
    kdRatio: finiteOrNull(stats?.kdRatio ?? (deaths > 0 ? totalKills / deaths : null)),
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
