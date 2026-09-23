import type { GameMode } from "../../types/seasonal.ts";

export const ADMIN_RISK_SCORE_VERSIONS: Record<GameMode, number> = {
  regular: 2,
  pve: 2,
  arena: 1,
  seasonal: 2,
};

export function riskScoreVersion(mode: GameMode, cycleId?: string): number {
  if (mode === "seasonal" && !cycleId) throw new TypeError("seasonal risk requires cycleId");
  return ADMIN_RISK_SCORE_VERSIONS[mode];
}
