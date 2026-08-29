import { bracketFor } from "@/lib/brackets";
import { scoreCheater, type AchievementInput, type AchievementStat, type Baseline, type CheaterScoreResult } from "@/lib/cheater-score";
import { getStore, type CrossSectionMode, type PlayerStore } from "@/lib/db";
import { getSeasonalAchievementBaseline, getSeasonalRiskBaseline, type SeasonalAchievementBaseline } from "@/lib/seasonal/average-db";
import { saveRiskEvaluation } from "@/lib/admin/moderation-db";
import type { ParsedPlayerStats } from "@/types/tarkov";
import type { GameMode, SeasonalAchievementUnlock, SeasonalProfile } from "@/types/seasonal";
import type { AchievementBaseline } from "@/lib/db";

export const ADMIN_RISK_SCORE_VERSION = 1;

/** Arena risk has its own display-only model and must not enter legacy moderation. */
export class ArenaRiskUnsupportedError extends TypeError {
  constructor() {
    super("Arena risk is display-only");
    this.name = "ArenaRiskUnsupportedError";
  }
}

/** Computes and stores one profile risk snapshot; callers may safely run this via Next after(). */
export async function evaluateAndStoreRisk(input: {
  aid: number;
  mode: GameMode;
  cycleId?: string;
  stats: ParsedPlayerStats;
  achievementIds: string[];
  achievementUnlocks?: SeasonalAchievementUnlock[];
  playerStore?: PlayerStore | null;
  evaluatedAt?: number;
}): Promise<CheaterScoreResult> {
  if (!Number.isSafeInteger(input.aid) || input.aid <= 0) throw new TypeError("invalid aid");
  if (input.mode === "arena") throw new ArenaRiskUnsupportedError();
  const bracket = bracketFor(input.stats.hoursPlayed);
  let baseline: Baseline | null = null;
  let achievementBaseline: AchievementBaseline | SeasonalAchievementBaseline | null = null;
  if (input.mode === "seasonal") {
    if (!input.cycleId) throw new TypeError("seasonal risk requires cycleId");
    [baseline, achievementBaseline] = await Promise.all([
      getSeasonalRiskBaseline(input.cycleId, bracket.lo, bracket.hi),
      getSeasonalAchievementBaseline(input.cycleId),
    ]);
  } else {
    const baselineMode: CrossSectionMode = input.mode;
    const store = input.playerStore === undefined ? await getStore(baselineMode) : input.playerStore;
    [baseline, achievementBaseline] = store
      ? await Promise.all([store.baseline(bracket.lo, bracket.hi), store.achievementBaseline()])
      : [null, null];
  }
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
            : 0,
        meanHours: achievement.meanHours,
        earlyHours: achievement.earlyHours,
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
  const result = scoreCheater(input.stats, baseline, achievementInput);
  const evaluationTime = input.evaluatedAt ?? Date.now();
  await saveRiskEvaluation({
    aid: input.aid,
    mode: input.mode,
    cycleId: input.cycleId ?? (input.mode === "seasonal" ? "unknown" : "persistent"),
    score: result.score,
    tier: result.tier,
    factors: result.factors,
    scoreVersion: ADMIN_RISK_SCORE_VERSION,
    profileUpdatedAt: Number(input.stats.profileUpdatedAt) || 0,
    evaluatedAt: evaluationTime,
    sampleN: result.sampleN,
    confidence: Math.min(1, result.sampleN / 30),
    freshnessAt: evaluationTime,
  });
  return result;
}

export async function evaluateAndStoreSeasonalRisk(
  profile: SeasonalProfile,
  evaluatedAt?: number
): Promise<CheaterScoreResult> {
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
  return evaluateAndStoreRisk({
    aid: profile.aid,
    mode: "seasonal",
    cycleId: profile.cycleId,
    stats,
    achievementIds: profile.seasonalAchievements?.map((achievement) => achievement.id)
      ?? profile.staticSignals?.achievementIds
      ?? [],
    achievementUnlocks: profile.seasonalAchievements ?? undefined,
    evaluatedAt,
  });
}
