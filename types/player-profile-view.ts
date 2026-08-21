import type { GameMode, ProfileIdentity } from "@/types/seasonal";

export const PROFILE_SECTION_ORDER = [
  "overview",
  "progression",
  "risk",
  "comparison",
  "statistics",
  "achievements",
  "skills",
] as const;

export type ProfileSectionId = (typeof PROFILE_SECTION_ORDER)[number];
export type ProfileViewMode = Extract<GameMode, "regular" | "seasonal">;

export interface ProfileViewFreshness {
  profileUpdatedAt: number | null;
  lastAccessAt: number | null;
  capturedAt: number | null;
}

export interface ProfileViewIdentity extends ProfileIdentity {
  nickname: string;
}

export interface ProfileViewMetricSet {
  lifetimePvpHours: number | null;
  pmcKdRatio: number | null;
  pmcSurvivalRate: number | null;
  pmcRaids: number | null;
}

export interface ProfileViewAchievement {
  id: string;
  unlockedAt: number | null;
  name: string | null;
  nameRu: string | null;
  rarity: string | null;
  owners: number | null;
  eligibleN: number | null;
  percentage: number | null;
  /** BSG's official completion percentage for this achievement. */
  officialPercentage: number | null;
}

export interface ProfileViewSkill {
  id: string;
  progress: number | null;
  pointsEarnedDuringSession: number | null;
  lastAccess: number | null;
}

export interface ProfileViewRisk {
  score: number | null;
  tier: string | null;
  confidence: number | null;
  sampleN: number | null;
  freshnessAt: number | null;
  factors: Array<{ key: string; points: number | null; available?: boolean }>;
  mode: ProfileViewMode;
  cycleId: string;
}

export interface PlayerProfileViewModel {
  identity: ProfileViewIdentity;
  mode: ProfileViewMode;
  cycleId: string;
  sectionOrder: readonly ProfileSectionId[];
  freshness: ProfileViewFreshness;
  overview: ProfileViewMetricSet;
  progression: {
    level: number | null;
    experience: number | null;
    prestige: number | null;
    achievementsCount: number | null;
  };
  risk: ProfileViewRisk | null;
  comparison: {
    lifetimePvpHours: number | null;
    pmcRaids: number | null;
    cohortMode: ProfileViewMode;
    cohortCycleId: string;
  };
  statistics: {
    totalRaids: number | null;
    pmcRaids: number | null;
    scavRaids: number | null;
    survivalRate: number | null;
    pmcSurvivalRate: number | null;
    kdRatio: number | null;
    pmcKdRatio: number | null;
    totalKills: number | null;
    pmcKills: number | null;
    deaths: number | null;
    runThrough: number | null;
    level: number | null;
    prestige: number | null;
  };
  achievements: {
    items: ProfileViewAchievement[];
  };
  skills: {
    kind: "pvp" | "seasonal";
    items: ProfileViewSkill[];
    /** Legacy alias retained for the existing profile shell. */
    achievements: ProfileViewAchievement[];
  };
  /** Convenience alias used by the shared client shell. */
  seasonalAchievements?: Array<ProfileViewAchievement & { name: string; rarity: string }>;
}
