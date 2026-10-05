import { getStore } from "@/lib/db";
import { getProgressionStore } from "@/lib/progression-db";
import { getSeasonalStore } from "@/lib/seasonal/storage";
import { querySeasonalComparisonCohort } from "@/lib/seasonal/comparison-cohort";
import { getArenaProfile, getArenaCohort, getArenaAverage } from "@/lib/arena/service";
import { loadDynamicAverage } from "@/lib/average-dynamic-cache";
import { arenaAverageCacheVersion } from "@/lib/arena-average-cache";
import { rateArenaMode } from "@/lib/arena/ts-rating";
import { arenaTsReference } from "@/lib/arena/ts-rating-reference";
import type { ParsedPlayerStats } from "@/types/tarkov";
import type { LeaderboardPreview, LeaderboardPreviewMetric, LeaderboardPreviewScope } from "@/types/leaderboard-preview";
import type { ComparisonCohortResult } from "@/lib/profile-cohort";
import { finiteNonNegativeMetricValue as finite } from "@/lib/profile-cohort";

function persistentMetrics(stats: Partial<ParsedPlayerStats>, cohort: ComparisonCohortResult | null): LeaderboardPreviewMetric[] {
  const killedPerRaid = stats.pvpStatsVersion === 1 && stats.pmcKilledPmc != null && (stats.pmcRaids ?? 0) > 0
    ? stats.pmcKilledPmc / stats.pmcRaids! : null;
  const values = [
    ["metric.pmc_kd_ratio", stats.pvpStatsKnown === true ? stats.pmcKdRatio : null, "pmc_kd_ratio", 2],
    ["metric.kd_ratio", stats.kdRatio, "kd_ratio", 2],
    ["metric.pmc_survival_rate", stats.pmcSurvivalRate, "pmc_survival_rate", 1, true],
    ["metric.kills_per_raid", stats.killsPerRaid, "kills_per_raid", 2],
    ["seasonal.metric.pmcKillsPerRaid", killedPerRaid, "killed_pmc_per_raid", 2],
    ["metric.longest_win_streak", stats.longestWinStreak, "longest_win_streak", 0],
  ] as const;
  return values.map(([label, value, key, digits, percent]) => ({
    label, value: finite(value), digits, percent,
    average: cohort?.quality === "sufficient" ? finite(cohort.averages[key]?.value) : null,
  }));
}

/** Hover previews read stored snapshots only. They never refresh a profile or evaluate risk. */
export async function loadLeaderboardPreview(aid: number, scope: LeaderboardPreviewScope): Promise<LeaderboardPreview | null> {
  if (scope.mode === "arena") {
    const mode = scope.arenaMode!;
    const profile = await getArenaProfile(aid);
    if (!profile) return null;
    const version = await arenaAverageCacheVersion();
    const loaded = await loadDynamicAverage(`preview-arena-cohort:${aid}:${mode}:${version}:${profile.profileUpdatedAt}:${profile.parserVersion}`, async () => {
      const matched = await getArenaCohort(aid, mode);
      if (matched?.reason !== "insufficient_cohort") return matched;
      // Same matched-group -> population fallback as the full Arena comparison.
      const population = await getArenaAverage({ mode, statistic: "trimmed_mean" });
      return population && population.sampleN >= 20 ? { ...matched, quality: "sufficient" as const, metrics: population.metrics } : matched;
    });
    const stats = profile.modes[mode];
    const cohort = loaded.value;
    const labels = { kd_ratio: "arena.metric.kd_ratio", win_rate: "arena.metric.win_rate", kills_per_match: "arena.metric.kills_per_match", damage_per_match: "arena.metric.damage_per_match", headshot_rate: "arena.metric.headshot_rate" } as const;
    const rating = rateArenaMode(stats.counters, arenaTsReference.modes[mode]);
    return { ...scope, aid, nickname: profile.nickname, side: null, level: null, prestige: null,
      updatedAt: finite(profile.profileUpdatedAt), hours: finite(profile.overall.hours), raids: finite(stats.counters.matches),
      bestArp: finite(profile.overall.bestArp),
      metrics: [...Object.entries(labels).map(([key, label]) => {
        const metric = key as keyof typeof labels;
        const baseline = cohort?.quality === "sufficient" ? cohort.metrics[metric] : null;
        return { label, value: finite(stats.metrics[metric]), average: baseline && baseline.count >= 20 ? finite(baseline.value) : null,
          digits: metric === "damage_per_match" ? 0 : metric === "kd_ratio" ? 2 : 1,
          percent: metric === "win_rate" || metric === "headshot_rate" };
      }), { label: "arena.tsr.title", value: rating.displayReady ? finite(rating.rating) : null, average: null, digits: 2,
        note: rating.reason ? `arena.tsr.reason.${rating.reason}` : rating.provisional ? "arena.tsr.provisional" : "leaderboard.preview.ratingBaseline" }],
      totals: (["kills", "deaths", "wins", "losses"] as const).map((key) => ({ label: `arena.counter.${key}`, value: finite(stats.counters[key]) })),
    };
  }

  let stats: Partial<ParsedPlayerStats>;
  let cohort: ComparisonCohortResult | null;
  if (scope.mode === "pvp-season") {
    const store = await getSeasonalStore();
    const profile = await store?.getProfile({ mode: "seasonal", cycleId: scope.cycleId!, aid });
    if (!profile) return null;
    const c = profile.counters;
    const s = profile.seasonalStats;
    const exactKills = profile.pvpStatsVersion === 1 ? c.pmcKilledPmc : null;
    stats = { nickname: profile.nickname, side: profile.side ?? undefined, level: s?.level ?? undefined, prestige: s?.prestige ?? profile.staticSignals?.prestige,
      profileUpdatedAt: profile.profileUpdatedAt, hoursPlayed: profile.lifetimePvpHours ?? undefined,
      pmcRaids: c.pmcRaids, pmcKilledPmc: exactKills, pvpStatsVersion: profile.pvpStatsVersion, pvpStatsKnown: exactKills != null,
      totalKills: s?.totalKills ?? c.pmcKills, killedPmc: exactKills ?? undefined, pmcSurvived: c.pmcSurvived, pmcDeaths: c.pmcDeaths,
      kdRatio: s?.kdRatio ?? (c.pmcDeaths > 0 ? c.pmcKills / c.pmcDeaths : c.pmcKills),
      pmcKdRatio: exactKills != null ? (c.pmcDeaths > 0 ? exactKills / c.pmcDeaths : exactKills) : undefined,
      killsPerRaid: s?.killsPerRaid ?? (c.pmcRaids > 0 ? c.pmcKills / c.pmcRaids : undefined),
      pmcSurvivalRate: s?.pmcSurvivalRate ?? (c.pmcRaids > 0 ? 100 * c.pmcSurvived / c.pmcRaids : undefined),
      longestWinStreak: s?.longestWinStreak ?? profile.staticSignals?.longestWinStreak };
    cohort = (await querySeasonalComparisonCohort({ aid, cycleId: scope.cycleId! })).result;
  } else {
    const store = await getStore(scope.mode);
    if (!store) return null;
    // The cross-section may lag a recorded profile; use the same latest-snapshot preference as /api/average/cohort.
    const progression = await getProgressionStore(scope.mode).catch(() => null);
    const snapshot = await progression?.latest(aid);
    const stored = snapshot?.stats ?? (await store.stored(aid))?.stats;
    if (!stored) return null;
    stats = stored;
    const loaded = await loadDynamicAverage(`preview-cohort-v1:${scope.mode}:${aid}:${stats.profileUpdatedAt}:${stats.pvpStatsVersion}`, () =>
      store.cohort2d(stats.hoursPlayed ?? 0, stats.pmcRaids ?? 0, aid, "hours", "trimmed_mean", "all"));
    cohort = loaded.value;
  }
  return { ...scope, aid, nickname: stats.nickname ?? `#${aid}`, side: stats.side ?? null, level: finite(stats.level), prestige: finite(stats.prestige),
    updatedAt: finite(stats.profileUpdatedAt), hours: finite(stats.hoursPlayed), raids: finite(stats.pmcRaids), metrics: persistentMetrics(stats, cohort),
    totals: [
      { label: "player.totalKills", value: finite(stats.totalKills) },
      { label: "player.pmcKills", value: stats.pvpStatsKnown === true ? finite(stats.pmcKilledPmc) : null },
      { label: "leaderboard.preview.survived", value: finite(stats.pmcSurvived) },
      { label: "player.deaths", value: finite(stats.pmcDeaths) },
    ] };
}
