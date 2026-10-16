import { EVENT_ACHIEVEMENT_IDS, hasValidRiskInputs, scoreCheater, scoreSeasonalCheater, type AchievementInput, type AchievementStat, type Baseline, type CheaterScoreResult } from "@/lib/cheater-score";
import { getStore, type CrossSectionMode, type PlayerStore } from "@/lib/db";
import { getSeasonalAchievementBaseline, getSeasonalRiskBaseline, type SeasonalAchievementBaseline } from "@/lib/seasonal/average-db";
import { getModerationStore } from "@/lib/admin/moderation-db";
import { createRequestTiming, type RequestTimingInput } from "@/lib/observability/request-timing";
import { riskScoreVersion } from "@/lib/admin/risk-version";
import type { ParsedPlayerStats } from "@/types/tarkov";
import type { GameMode, SeasonalAchievementUnlock, SeasonalProfile } from "@/types/seasonal";
import type { AchievementBaseline } from "@/lib/db";
import { scoreRegularCheater } from "@/lib/regular-risk-score";

export { ADMIN_RISK_SCORE_VERSIONS, riskScoreVersion } from "@/lib/admin/risk-version";

export class ArenaRiskUnsupportedError extends TypeError {
  constructor() {
    super("Arena risk is display-only");
    this.name = "ArenaRiskUnsupportedError";
  }
}

function hasUsableRiskMetrics(baseline: Baseline | null): boolean {
  return baseline != null && baseline.n > 0 && Object.values(baseline.metrics).some((metric) =>
    metric.n > 0 && Number.isFinite(metric.mean) && Number.isFinite(metric.std)
  );
}

export async function evaluateAndStoreRisk(input: {
  aid: number;
  mode: GameMode;
  cycleId?: string;
  stats: ParsedPlayerStats;
  achievementIds: string[];
  achievementUnlocks?: SeasonalAchievementUnlock[];
  playerStore?: PlayerStore | null;
  evaluatedAt?: number;
  /** Includes FIFO, process startup and IPC; never part of the scoring model. */
  queuedAt?: number;
}): Promise<CheaterScoreResult> {
  if (!Number.isSafeInteger(input.aid) || input.aid <= 0) throw new TypeError("invalid aid");
  if (input.mode === "arena") throw new ArenaRiskUnsupportedError();
  const timing = createRequestTiming();
  const startedAt = timing.now();
  const phases: Partial<RequestTimingInput> = {};
  const queueMs = input.queuedAt === undefined ? undefined : Math.max(0, Date.now() - input.queuedAt);
  let outcome: "success" | "error" = "error";
  let failureStage: "storage" | "application" = "storage";
  const measure = async <T>(phase: "storeOpenMs" | "cohortMs" | "achievementsMs", read: () => Promise<T>): Promise<T> => {
    const started = timing.now();
    try { return await read(); }
    finally { phases[phase] = (phases[phase] ?? 0) + timing.elapsedMs(started); }
  };
  try {
    const canScore = Number.isFinite(input.stats.hoursPlayed) && input.stats.hoursPlayed > 0 &&
      Number.isFinite(input.stats.pmcRaids) && input.stats.pmcRaids > 0 &&
      (input.mode === "regular" || hasValidRiskInputs(input.stats));
    let baseline: Baseline | null = null;
    let achievementBaseline: AchievementBaseline | SeasonalAchievementBaseline | null = null;
    if (canScore && input.mode === "seasonal") {
      if (!input.cycleId) throw new TypeError("seasonal risk requires cycleId");
      [baseline, achievementBaseline] = await Promise.all([
        measure("cohortMs", () => getSeasonalRiskBaseline(input.cycleId!, {
          hours: input.stats.hoursPlayed,
          pmcRaids: input.stats.pmcRaids,
        }, input.aid)),
        measure("achievementsMs", () => getSeasonalAchievementBaseline(input.cycleId!, input.aid)),
      ]);
    } else if (canScore || input.mode === "regular") {
      const baselineMode: CrossSectionMode = input.mode === "pve" ? "pve" : "regular";
      const store = input.playerStore === undefined ? await measure("storeOpenMs", () => getStore(baselineMode)) : input.playerStore;
      if (store) {
        if (input.mode === "regular") {
          // These SQLite stages run synchronously. Measure them sequentially so
          // achievement SQL is not counted again in the cohort duration.
          baseline = canScore ? await measure("cohortMs", () => store.riskBaseline(input.stats.hoursPlayed, input.stats.pmcRaids, input.aid)) : null;
          achievementBaseline = await measure("achievementsMs", () => store.achievementRiskBaseline(input.achievementIds.filter((id) => !EVENT_ACHIEVEMENT_IDS.has(id)), input.aid));
        } else {
          [baseline, achievementBaseline] = await Promise.all([
            measure("cohortMs", () => store.riskBaseline2d(input.stats.hoursPlayed, input.stats.pmcRaids, input.aid, "all")),
            measure("achievementsMs", () => store.achievementBaseline()),
          ]);
        }
      }
    }
    failureStage = "application";
    const scoreStarted = timing.now();
    let achievementInput: AchievementInput | null = null;
    if (achievementBaseline) {
      const seasonalBaseline = "prevalencePct" in (achievementBaseline.achievements[0] ?? {});
      const seasonStartsAt = "seasonStartsAt" in achievementBaseline
        ? achievementBaseline.seasonStartsAt
        : null;
      const stats: AchievementStat[] = achievementBaseline.achievements.map((achievement) => {
        const stat: AchievementStat = {
          id: achievement.ach_id,
          owners: achievement.owners,
          samplePct: seasonalBaseline && "prevalencePct" in achievement
            ? achievement.prevalencePct
            : achievementBaseline.total > 0
              ? achievement.owners / achievementBaseline.total * 100
              : input.mode === "regular" ? Number.NaN : 0,
          meanHours: achievement.meanHours,
          earlyHours: achievement.earlyHours,
          hoursOwners: "hoursOwners" in achievement ? Number(achievement.hoursOwners) : undefined,
        };
        if (seasonalBaseline && "prevalencePct" in achievement) {
          stat.eligibleN = achievement.eligibleN;
          stat.unlockDayP20 = achievement.timestampOwners < 1 ? null : achievement.unlockDayP20;
        }
        return stat;
      });
      achievementInput = {
        ownedIds: input.achievementIds,
        seasonal: input.mode === "seasonal",
        playerUnlockDays: Object.fromEntries((input.achievementUnlocks ?? [])
          .filter((achievement) => achievement.unlockedAt !== null)
          .map((achievement) => [
            achievement.id,
            (achievement.unlockedAt! - (seasonStartsAt ?? 0)) / 86_400_000,
          ])),
        stats,
      };
    }
    const result = input.mode === "regular"
      ? scoreRegularCheater(input.stats, baseline, achievementInput)
      : input.mode === "seasonal"
      ? scoreSeasonalCheater(input.stats, baseline, achievementInput)
      : canScore && hasUsableRiskMetrics(baseline)
        ? scoreCheater(input.stats, baseline, achievementInput)
        : scoreCheater({ ...input.stats, pmcRaids: 0 }, null, null);
    phases.riskMs = timing.elapsedMs(scoreStarted);
    const evaluationTime = input.evaluatedAt ?? Date.now();
    failureStage = "storage";
    const moderation = await measure("storeOpenMs", () => getModerationStore());
    const writeStarted = timing.now();
    try {
      moderation.saveRisk({
        aid: input.aid,
        mode: input.mode,
        cycleId: input.cycleId ?? (input.mode === "seasonal" ? "unknown" : "persistent"),
        score: result.score,
        tier: result.tier,
        factors: result.factors,
        scoreVersion: riskScoreVersion(input.mode, input.cycleId),
        profileUpdatedAt: Number(input.stats.profileUpdatedAt) || 0,
        evaluatedAt: evaluationTime,
        sampleN: result.sampleN,
        confidence: result.confidence ?? Math.min(1, result.sampleN / 30),
        availability: result.availability,
        profileParserVersion: input.mode === "regular" ? input.stats.pvpStatsParserVersion ?? 0 : undefined,
        freshnessAt: evaluationTime,
      });
    } finally { phases.storeWriteMs = timing.elapsedMs(writeStarted); }
    outcome = "success";
    return result;
  } finally {
    timing.finish({
      ...phases, operation: "risk_evaluation", mode: input.mode, outcome,
      status: outcome === "success" ? 200 : 503, queueMs,
      totalMs: timing.elapsedMs(startedAt) + (queueMs ?? 0),
      failureStage: outcome === "error" ? failureStage : undefined,
    });
  }
}

export function seasonalRiskInput(
  profile: SeasonalProfile,
  evaluatedAt?: number
): Parameters<typeof evaluateAndStoreRisk>[0] {
  const portrait = profile.seasonalStats;
  const raids = profile.counters.pmcRaids;
  const deaths = profile.counters.pmcDeaths;
  const kills = profile.counters.pmcKills;
  const stats = {
    nickname: profile.nickname,
    level: 0,
    prestige: profile.staticSignals?.prestige ?? 0,
    experience: profile.counters.experience,
    side: "",
    totalRaids: portrait?.totalRaids ?? raids + profile.counters.scavRaids,
    pmcRaids: raids,
    scavRaids: profile.counters.scavRaids,
    survivedRaids: portrait?.survivedRaids ?? profile.counters.pmcSurvived,
    survivalRate: portrait?.survivalRate ?? (raids > 0 ? profile.counters.pmcSurvived / raids * 100 : 0),
    totalKills: portrait?.totalKills ?? kills,
    pmcKilledPmc: profile.counters.killedPmc,
    killedPmc: profile.counters.killedPmc,
    killsPerRaid: raids > 0 ? kills / raids : 0,
    kdRatio: portrait?.kdRatio ?? (deaths > 0 ? kills / deaths : kills),
    pmcKdRatio: portrait?.pmcKdRatio ?? (deaths > 0 ? profile.counters.killedPmc / deaths : profile.counters.killedPmc),
    deaths,
    pmcDeaths: deaths,
    runThrough: 0,
    pmcSurvived: profile.counters.pmcSurvived,
    pmcSurvivalRate: portrait?.pmcSurvivalRate ?? (raids > 0 ? profile.counters.pmcSurvived / raids * 100 : 0),
    pmcKills: kills,
    pmcKillsPerRaid: raids > 0 ? kills / raids : 0,
    pmcExitKilled: 0,
    pmcExitLeft: 0,
    pmcExitTransit: 0,
    pmcExitMia: 0,
    hoursPlayed: profile.lifetimePvpHours ?? 0,
    longestWinStreak: profile.staticSignals?.longestWinStreak ?? 0,
    achievementsCount: profile.seasonalAchievements?.length
      ?? profile.staticSignals?.achievementIds.length
      ?? 0,
    registrationDate: 0,
    lastActiveDate: 0,
    profileUpdatedAt: profile.profileUpdatedAt,
    avgLifespan: 0,
    totalLootValue: 0,
  } satisfies ParsedPlayerStats;
  return {
    aid: profile.aid,
    mode: "seasonal",
    cycleId: profile.cycleId,
    stats,
    achievementIds: profile.seasonalAchievements?.map((achievement) => achievement.id)
      ?? profile.staticSignals?.achievementIds
      ?? [],
    achievementUnlocks: profile.seasonalAchievements ?? undefined,
    evaluatedAt,
  };
}

export async function evaluateAndStoreSeasonalRisk(
  profile: SeasonalProfile,
  evaluatedAt?: number,
): Promise<CheaterScoreResult> {
  return evaluateAndStoreRisk(seasonalRiskInput(profile, evaluatedAt));
}
