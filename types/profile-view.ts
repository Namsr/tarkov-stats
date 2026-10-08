import type { GameMode } from "@/types/seasonal";
import type { ProfileViewMode } from "@/types/player-profile-view";

export type ProfileShellMode = ProfileViewMode;

export interface ProfileViewMetric {
  label: string;
  value: string | number;
  suffix?: string;
}

export type PublicRiskTier = "low" | "medium" | "high" | "severe";

export interface PublicRiskFactor {
  key: string;
  points?: number | null;
  label?: string | null;
  available?: boolean;
  value?: number;
  cohortMean?: number | null;
  cohortN?: number | null;
  p90?: number | null;
  p99?: number | null;
  ratio?: number | null;
  hoursMultiplier?: number;
  evidencePoints?: number;
  group?: string;
  reason?: string;
  achievementId?: string;
  ownerHoursP20?: number | null;
  cohortPercent?: number;
}

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
  profileUpdatedAt?: number | null;
  factors?: string[] | PublicRiskFactor[];
  availability?: "available" | "partial" | "unavailable";
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
  killedPmcPerRaid: number | null;
  pmcSurvivalRate: number | null;
  longestWinStreak: number | null;
  level: number | null;
  pvpStatsKnown?: boolean;
}
