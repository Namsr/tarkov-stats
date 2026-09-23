import type { GameMode } from "../../types/seasonal.ts";

export const ADMIN_RISK_SCORE_VERSION = 2;

export function adminRiskScoreVersionForMode(mode: GameMode): number {
  return mode === "pve" ? ADMIN_RISK_SCORE_VERSION : 1;
}
