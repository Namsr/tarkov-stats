import type { GameMode, ProfileIdentity } from "@/types/seasonal";

export type ProfileShellMode = Extract<GameMode, "regular" | "seasonal">;

export interface ProfileViewMetric {
  label: string;
  value: string | number;
  suffix?: string;
}

export type PublicRiskTier = "low" | "medium" | "high" | "severe";

/**
 * Public, server-derived risk data.  The client may render this DTO, but it
 * must never calculate a score from raw stats or a client supplied baseline.
 */
export interface PublicRiskView {
  aid?: number;
  mode?: GameMode;
  cycleId?: string;
  score: number | null;
  tier?: string | null;
  confidence?: number | null;
  sampleN?: number | null;
  confidenceTier?: "low" | "medium" | "high" | null;
  sampleSize?: number | null;
  freshnessAt?: number | null;
  factors?: string[] | Array<{
    key: string;
    points?: number | null;
    label?: string | null;
    available?: boolean;
  }>;
  available?: boolean;
}

export interface SeasonalAchievementView {
  id: string;
  name: string;
  nameRu?: string | null;
  rarity: string;
  unlockedAt: number | null;
  owners: number | null;
  eligibleN: number | null;
  percentage: number | null;
}

export interface ProfileComparisonStats {
  hoursPlayed: number | null;
  pmcRaids: number | null;
  kdRatio: number | null;
  pmcKdRatio: number | null;
  killsPerRaid: number | null;
  pmcSurvivalRate: number | null;
  longestWinStreak: number | null;
  level: number | null;
  pvpStatsKnown?: boolean;
}

export interface ProfileViewModel {
  identity: ProfileIdentity;
  nickname: string;
  overview: ProfileViewMetric[];
  comparison: ProfileComparisonStats;
  risk: PublicRiskView | null;
  seasonalAchievements?: SeasonalAchievementView[];
}
