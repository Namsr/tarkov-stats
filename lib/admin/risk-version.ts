import type { ParsedPlayerStats } from "../../types/tarkov.ts";
import type { GameMode } from "../../types/seasonal.ts";

export const ADMIN_RISK_SCORE_VERSION = 2;
const ADMIN_RISK_TTL_MS = 5 * 60 * 60 * 1000;

export function adminRiskScoreVersionForMode(mode: GameMode): number {
  return mode === "pve" ? ADMIN_RISK_SCORE_VERSION : 1;
}

export function storedRiskRefreshPolicy<T extends { scoreVersion: number; profileUpdatedAt: number; evaluatedAt: number }>(
  risk: T | null | undefined,
  mode: GameMode,
  profileUpdatedAt: number,
  now = Date.now(),
): { refresh: boolean; publicRisk: T | null } {
  const current = risk?.scoreVersion === adminRiskScoreVersionForMode(mode);
  return {
    refresh: !current || !risk || risk.profileUpdatedAt < profileUpdatedAt || now - risk.evaluatedAt >= ADMIN_RISK_TTL_MS,
    publicRisk: current ? risk : null,
  };
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
