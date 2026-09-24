import type { GameMode } from "../../types/seasonal.ts";

export const ADMIN_RISK_SCORE_VERSIONS: Record<GameMode, number> = {
  regular: 2,
  pve: 2,
  arena: 1,
  seasonal: 1,
};

const ADMIN_RISK_TTL_MS = 5 * 60 * 60 * 1000;

export function riskScoreVersion(mode: GameMode, cycleId?: string): number {
  if (mode === "seasonal" && !cycleId) throw new TypeError("seasonal risk requires cycleId");
  return ADMIN_RISK_SCORE_VERSIONS[mode];
}

export function storedRiskRefreshPolicy<T extends { scoreVersion: number; profileUpdatedAt: number; evaluatedAt: number }>(
  risk: T | null | undefined,
  mode: GameMode,
  profileUpdatedAt: number,
  now = Date.now(),
): { refresh: boolean; publicRisk: T | null } {
  const current = risk?.scoreVersion === riskScoreVersion(mode);
  return {
    refresh: !current || !risk || risk.profileUpdatedAt < profileUpdatedAt || now - risk.evaluatedAt >= ADMIN_RISK_TTL_MS,
    publicRisk: current ? risk : null,
  };
}
