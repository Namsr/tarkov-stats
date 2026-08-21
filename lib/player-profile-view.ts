import type { ParsedPlayerStats, PlayerProfile } from "@/types/tarkov";
import {
  PROFILE_SECTION_ORDER,
  type PlayerProfileViewModel,
  type ProfileViewAchievement,
  type ProfileViewRisk,
  type ProfileViewSkill,
} from "@/types/player-profile-view";
import type { ProfileIdentity, SeasonalProfile } from "@/types/seasonal";
import type { StoredRiskEvaluation } from "@/lib/admin/moderation-db";
import { safeAchievementImageUrl } from "@/lib/tarkov-api";

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function timestampOrNull(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 10_000_000_000 ? n * 1000 : n;
}

function achievementRows(value: unknown): ProfileViewAchievement[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ProfileViewAchievement[] => {
    if (typeof item === "string") {
      return [{
        id: item,
        unlockedAt: null,
        name: null,
        nameRu: null,
        description: null,
        descriptionRu: null,
        imageUrl: null,
        rarity: null,
        owners: null,
        eligibleN: null,
        percentage: null,
        officialPercentage: null,
      }];
    }
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const id = typeof row.id === "string"
      ? row.id
      : typeof row.achId === "string" ? row.achId : null;
    if (!id) return [];
    const eligibleN = finiteOrNull(row.eligibleN ?? row.eligible);
    const owners = finiteOrNull(row.owners);
    const percentage = finiteOrNull(row.percentage ?? row.samplePct);
    const officialPercentage = finiteOrNull(
      row.officialPercentage ?? row.officialPct ?? row.playersCompletedPercent,
    );
    return [{
      id,
      unlockedAt: timestampOrNull(row.unlockedAt),
      name: typeof row.name === "string" ? row.name : null,
      nameRu: typeof row.nameRu === "string" ? row.nameRu : null,
      description: typeof row.description === "string"
        ? row.description
        : typeof row.descriptionEn === "string" ? row.descriptionEn : null,
      descriptionRu: typeof row.descriptionRu === "string" ? row.descriptionRu : null,
      imageUrl: safeAchievementImageUrl(row.imageUrl ?? row.imageLink),
      rarity: typeof row.rarity === "string" ? row.rarity : null,
      owners,
      eligibleN,
      percentage: percentage ?? (owners != null && eligibleN ? owners / eligibleN * 100 : null),
      officialPercentage,
    }];
  });
}

function skillRows(value: unknown): ProfileViewSkill[] {
  let raw: unknown[] = [];
  if (Array.isArray(value)) {
    raw = value;
  } else if (value && typeof value === "object") {
    const common = (value as Record<string, unknown>).Common;
    if (Array.isArray(common)) raw = common;
  }
  return raw.flatMap((item): ProfileViewSkill[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const id = typeof row.Id === "string"
      ? row.Id
      : typeof row.id === "string" ? row.id : null;
    if (!id) return [];
    return [{
      id,
      progress: finiteOrNull(row.Progress ?? row.progress),
      pointsEarnedDuringSession: finiteOrNull(
        row.PointsEarnedDuringSession ?? row.pointsEarnedDuringSession,
      ),
      lastAccess: timestampOrNull(row.LastAccess ?? row.lastAccess),
    }];
  });
}

function identity(input: ProfileIdentity, nickname: string): PlayerProfileViewModel["identity"] {
  return { ...input, nickname };
}

function riskView(
  input: ProfileViewRisk | null | undefined,
  identityValue: ProfileIdentity,
): ProfileViewRisk | null {
  if (!input) return null;
  return {
    ...input,
    mode: identityValue.mode as ProfileViewRisk["mode"],
    cycleId: identityValue.cycleId,
  };
}

function emptyRisk(): null {
  return null;
}

export function buildRegularProfileViewModel(
  input: { aid: number; mode: "regular"; cycleId: string; profile: PlayerProfile; stats: ParsedPlayerStats },
  risk?: ProfileViewRisk | null,
): PlayerProfileViewModel {
  const { profile, stats } = input;
  const identityValue = { aid: input.aid, mode: input.mode, cycleId: input.cycleId } as const;
  const ownAchievements = Object.entries(profile.achievements ?? {}).map(([id, unlockedAt]) => ({
    id,
    unlockedAt: timestampOrNull(unlockedAt),
    name: null,
    nameRu: null,
    description: null,
    descriptionRu: null,
    imageUrl: null,
    rarity: null,
    owners: null,
    eligibleN: null,
    percentage: null,
    officialPercentage: null,
  }));
  return {
    identity: identity(identityValue, stats.nickname),
    mode: "regular",
    cycleId: input.cycleId,
    sectionOrder: PROFILE_SECTION_ORDER,
    freshness: { profileUpdatedAt: timestampOrNull(stats.profileUpdatedAt), lastAccessAt: timestampOrNull(stats.lastPlayedAt), capturedAt: null },
    overview: {
      lifetimePvpHours: finiteOrNull(stats.hoursPlayed),
      pmcKdRatio: stats.pvpStatsKnown === false ? null : finiteOrNull(stats.pmcKdRatio),
      pmcSurvivalRate: stats.pvpStatsKnown === false ? null : finiteOrNull(stats.pmcSurvivalRate),
      pmcRaids: finiteOrNull(stats.pmcRaids),
    },
    progression: {
      level: finiteOrNull(stats.level),
      experience: finiteOrNull(stats.experience),
      prestige: finiteOrNull(stats.prestige),
      achievementsCount: finiteOrNull(stats.achievementsCount),
    },
    risk: riskView(risk, identityValue),
    comparison: {
      lifetimePvpHours: finiteOrNull(stats.hoursPlayed),
      pmcRaids: finiteOrNull(stats.pmcRaids),
      cohortMode: "regular",
      cohortCycleId: input.cycleId,
    },
    statistics: {
      totalRaids: finiteOrNull(stats.totalRaids),
      pmcRaids: finiteOrNull(stats.pmcRaids),
      scavRaids: finiteOrNull(stats.scavRaids),
      survivalRate: finiteOrNull(stats.survivalRate),
      pmcSurvivalRate: finiteOrNull(stats.pmcSurvivalRate),
      kdRatio: finiteOrNull(stats.kdRatio),
      pmcKdRatio: stats.pvpStatsKnown === false ? null : finiteOrNull(stats.pmcKdRatio),
      totalKills: finiteOrNull(stats.totalKills),
      pmcKills: stats.pvpStatsKnown === false ? null : finiteOrNull(stats.pmcKilledPmc),
      deaths: finiteOrNull(stats.deaths),
      runThrough: finiteOrNull(stats.runThrough),
      level: finiteOrNull(stats.level),
      prestige: finiteOrNull(stats.prestige),
    },
    achievements: { items: ownAchievements },
    skills: { kind: "pvp", items: skillRows(profile.skills), achievements: ownAchievements },
  };
}

export function toPublicRiskView(
  risk: StoredRiskEvaluation | null | undefined,
  identityValue: ProfileIdentity,
): ProfileViewRisk | null {
  if (!risk) return null;
  return {
    score: Number.isFinite(risk.score) ? risk.score : null,
    tier: risk.tier,
    confidence: risk.confidence == null ? null : risk.confidence,
    sampleN: risk.sampleN == null ? null : risk.sampleN,
    freshnessAt: risk.freshnessAt ?? risk.evaluatedAt ?? null,
    factors: risk.factors.map((factor) => ({
      key: factor.key,
      points: factor.points,
      available: factor.available,
    })),
    mode: identityValue.mode as ProfileViewRisk["mode"],
    cycleId: identityValue.cycleId,
  };
}

export function buildSeasonalProfileViewModel(
  input: { profile: SeasonalProfile; capturedAt?: number | null },
  risk?: ProfileViewRisk | null,
): PlayerProfileViewModel {
  const profile = input.profile;
  const stats = profile.seasonalStats;
  const counters = profile.counters;
  const ownAchievements = achievementRows(
    (profile as SeasonalProfile & { seasonalAchievements?: unknown }).seasonalAchievements
      ?? (profile as SeasonalProfile & { achievements?: unknown }).achievements,
  );
  const commonSkills = (profile as SeasonalProfile & { commonSkills?: unknown }).commonSkills;
  const identityValue = { aid: profile.aid, mode: "seasonal" as const, cycleId: profile.cycleId };
  return {
    identity: identity(identityValue, profile.nickname),
    mode: "seasonal",
    cycleId: profile.cycleId,
    sectionOrder: PROFILE_SECTION_ORDER,
    freshness: {
      profileUpdatedAt: timestampOrNull(profile.profileUpdatedAt),
      lastAccessAt: timestampOrNull(profile.lastAccessAt),
      capturedAt: timestampOrNull(input.capturedAt),
    },
    overview: {
      lifetimePvpHours: finiteOrNull(profile.lifetimePvpHours),
      pmcKdRatio: finiteOrNull(stats?.pmcKdRatio),
      pmcSurvivalRate: finiteOrNull(stats?.pmcSurvivalRate ?? (counters.pmcRaids > 0 ? counters.pmcSurvived / counters.pmcRaids * 100 : null)),
      pmcRaids: finiteOrNull(counters.pmcRaids),
    },
    progression: {
      level: finiteOrNull(stats?.level),
      experience: finiteOrNull(counters.experience),
      prestige: finiteOrNull(stats?.prestige ?? profile.staticSignals?.prestige),
      achievementsCount: finiteOrNull(stats?.achievementsCount ?? ownAchievements.length),
    },
    risk: riskView(risk, identityValue) ?? emptyRisk(),
    comparison: {
      lifetimePvpHours: finiteOrNull(profile.lifetimePvpHours),
      pmcRaids: finiteOrNull(counters.pmcRaids),
      cohortMode: "seasonal",
      cohortCycleId: profile.cycleId,
    },
    statistics: {
      totalRaids: finiteOrNull(stats?.totalRaids ?? counters.pmcRaids + counters.scavRaids),
      pmcRaids: finiteOrNull(counters.pmcRaids),
      scavRaids: finiteOrNull(counters.scavRaids),
      survivalRate: finiteOrNull(stats?.survivalRate),
      pmcSurvivalRate: finiteOrNull(stats?.pmcSurvivalRate ?? (counters.pmcRaids > 0 ? counters.pmcSurvived / counters.pmcRaids * 100 : null)),
      kdRatio: finiteOrNull(stats?.kdRatio),
      pmcKdRatio: finiteOrNull(stats?.pmcKdRatio),
      totalKills: finiteOrNull(stats?.totalKills ?? counters.pmcKills),
      pmcKills: finiteOrNull(counters.killedPmc),
      deaths: finiteOrNull(stats?.deaths ?? counters.pmcDeaths),
      runThrough: finiteOrNull(stats?.runThrough),
      level: finiteOrNull(stats?.level),
      prestige: finiteOrNull(stats?.prestige ?? profile.staticSignals?.prestige),
    },
    achievements: { items: ownAchievements },
    skills: { kind: "seasonal", items: skillRows(commonSkills), achievements: ownAchievements },
    seasonalAchievements: ownAchievements.map((achievement) => ({
      ...achievement,
      name: achievement.name ?? achievement.id,
      rarity: achievement.rarity ?? "common",
    })),
  };
}
