import { bracketFor } from "@/lib/brackets";
import { scoreCheater, type CheaterScoreResult } from "@/lib/cheater-score";
import { getStore, type CrossSectionMode, type PlayerStore } from "@/lib/db";
import { saveRiskEvaluation } from "@/lib/admin/moderation-db";
import type { ParsedPlayerStats } from "@/types/tarkov";
import type { GameMode, SeasonalProfile } from "@/types/seasonal";

export const ADMIN_RISK_SCORE_VERSION = 1;

/** Computes and stores one profile risk snapshot; callers may safely run this via Next after(). */
export async function evaluateAndStoreRisk(input: {
  aid: number;
  mode: GameMode;
  cycleId?: string;
  stats: ParsedPlayerStats;
  achievementIds: string[];
  playerStore?: PlayerStore | null;
  evaluatedAt?: number;
}): Promise<CheaterScoreResult> {
  if (!Number.isSafeInteger(input.aid) || input.aid <= 0) throw new TypeError("invalid aid");
  const baselineMode: CrossSectionMode = input.mode === "seasonal" ? "regular" : input.mode;
  const store = input.playerStore === undefined ? await getStore(baselineMode) : input.playerStore;
  const bracket = bracketFor(input.stats.hoursPlayed);
  const [baseline, achievementBaseline] = store
    ? await Promise.all([store.baseline(bracket.lo, bracket.hi), store.achievementBaseline()])
    : [null, null];
  const result = scoreCheater(input.stats, baseline, achievementBaseline ? {
    ownedIds: input.achievementIds,
    stats: achievementBaseline.achievements.map((achievement) => ({
      id: achievement.ach_id,
      owners: achievement.owners,
      samplePct: achievementBaseline.total > 0
        ? achievement.owners / achievementBaseline.total * 100
        : 0,
      meanHours: achievement.meanHours,
      earlyHours: achievement.earlyHours,
    })),
  } : null);
  await saveRiskEvaluation({
    aid: input.aid,
    mode: input.mode,
    cycleId: input.cycleId ?? (input.mode === "seasonal" ? "unknown" : "persistent"),
    score: result.score,
    tier: result.tier,
    factors: result.factors,
    scoreVersion: ADMIN_RISK_SCORE_VERSION,
    profileUpdatedAt: Number(input.stats.profileUpdatedAt) || 0,
    evaluatedAt: input.evaluatedAt,
  });
  return result;
}

export async function evaluateAndStoreSeasonalRisk(
  profile: SeasonalProfile,
  evaluatedAt?: number
): Promise<CheaterScoreResult> {
  const raids = profile.counters.pmcRaids;
  const deaths = profile.counters.pmcDeaths;
  const kills = profile.counters.pmcKills;
  const stats = {
    nickname: profile.nickname,
    level: 0,
    prestige: profile.staticSignals?.prestige ?? 0,
    experience: profile.counters.experience,
    side: "",
    totalRaids: raids + profile.counters.scavRaids,
    pmcRaids: raids,
    scavRaids: profile.counters.scavRaids,
    survivedRaids: profile.counters.pmcSurvived,
    survivalRate: raids > 0 ? profile.counters.pmcSurvived / raids * 100 : 0,
    totalKills: kills,
    pmcKilledPmc: profile.counters.killedPmc,
    killedPmc: profile.counters.killedPmc,
    killsPerRaid: raids > 0 ? kills / raids : 0,
    kdRatio: deaths > 0 ? kills / deaths : kills,
    pmcKdRatio: deaths > 0 ? profile.counters.killedPmc / deaths : profile.counters.killedPmc,
    deaths,
    pmcDeaths: deaths,
    runThrough: 0,
    pmcSurvived: profile.counters.pmcSurvived,
    pmcSurvivalRate: raids > 0 ? profile.counters.pmcSurvived / raids * 100 : 0,
    pmcKills: kills,
    pmcKillsPerRaid: raids > 0 ? kills / raids : 0,
    pmcExitKilled: 0,
    pmcExitLeft: 0,
    pmcExitTransit: 0,
    pmcExitMia: 0,
    hoursPlayed: profile.lifetimePvpHours ?? 0,
    longestWinStreak: profile.staticSignals?.longestWinStreak ?? 0,
    achievementsCount: profile.staticSignals?.achievementIds.length ?? 0,
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
    achievementIds: profile.staticSignals?.achievementIds ?? [],
    evaluatedAt,
  });
}
