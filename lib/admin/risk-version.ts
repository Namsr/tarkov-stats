import type { GameMode } from "../../types/seasonal.ts";

export const ADMIN_RISK_SCORE_VERSIONS: Record<GameMode, number> = {
  regular: 2,
  pve: 1,
  arena: 1,
  seasonal: 1,
};

export function riskScoreVersion(mode: GameMode, cycleId?: string): number {
  if (mode === "seasonal" && !cycleId) throw new TypeError("seasonal risk requires cycleId");
  return ADMIN_RISK_SCORE_VERSIONS[mode];
}
