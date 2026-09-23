import type { ParsedPlayerStats } from "../../types/tarkov.ts";
import type { GameMode } from "../../types/seasonal.ts";

export const ADMIN_RISK_SCORE_VERSION = 2;

export function adminRiskScoreVersionForMode(mode: GameMode): number {
  return mode === "pve" ? ADMIN_RISK_SCORE_VERSION : 1;
}

const PVE_RISK_FIELDS = [
  "hoursPlayed",
  "pmcRaids",
  "pmcSurvivalRate",
  "pmcKdRatio",
  "pmcKillsPerRaid",
  "longestWinStreak",
  "prestige",
] as const;

export function pveRiskNeedsZero(stats: ParsedPlayerStats): boolean {
  if (stats.pvpStatsKnown !== true || !Number.isSafeInteger(stats.pmcRaids) || stats.pmcRaids < 0) {
    return true;
  }
  if (stats.pmcRaids === 0 || !(stats.hoursPlayed > 0)) return true;
  return PVE_RISK_FIELDS.some((field) => {
    const value = stats[field];
    return !Number.isFinite(value) || value < 0;
  });
}
