import type { ArenaModeKey } from "@/types/arena";
import type { LeaderboardMode, LeaderboardPrimaryMetric } from "@/types/leaderboard";
// @ts-expect-error Node's direct TypeScript runner needs the explicit extension.
import { loadSeasonalCycleConfig } from "../seasonal/config.ts";

export const LEADERBOARD_ACTIVITY_CUTOFF_MS = Date.parse("2025-11-15T00:00:00+03:00");
export const ARENA_LEADERBOARD_MODES: readonly ArenaModeKey[] = [
  "blastGang", "teamFight", "lastHero", "checkpoint", "shootOutDuo",
];

export interface LeaderboardScopeConfig {
  scope: string;
  mode: LeaderboardMode;
  arenaMode: ArenaModeKey | null;
  cycleId: string | null;
  primaryMetric: LeaderboardPrimaryMetric;
  minimumSample: number;
  activityCutoffMs: number;
  arpSeasonId: string | null;
  arpSourceConfirmed: boolean;
}

type SavedLeaderboardParams = Partial<LeaderboardScopeConfig> & {
  metricVersion?: number;
  exclusionFingerprint?: string;
  formula?: unknown;
};

function integerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

export function leaderboardScopeConfigs(): LeaderboardScopeConfig[] {
  const cutoff = integerEnv("LEADERBOARD_ACTIVITY_CUTOFF_MS", LEADERBOARD_ACTIVITY_CUTOFF_MS);
  const arenaCutoff = integerEnv("LEADERBOARD_ARENA_ACTIVITY_CUTOFF_MS", LEADERBOARD_ACTIVITY_CUTOFF_MS);
  // Product candidates for the first data run. Each mode remains independently configurable.
  const regularMinimum = integerEnv("LEADERBOARD_REGULAR_MINIMUM_RAIDS", 6);
  const pveMinimum = integerEnv("LEADERBOARD_PVE_MINIMUM_RAIDS", 6);
  const arenaMinimum = integerEnv("LEADERBOARD_ARENA_MINIMUM_MATCHES", 6);
  const lastHeroMinimum = integerEnv("LEADERBOARD_LAST_HERO_MINIMUM_MATCHES", arenaMinimum);
  const seasonId = (process.env.LEADERBOARD_ARP_SEASON_ID || "initial").trim();
  const confirmed = seasonId === "initial" || process.env.LEADERBOARD_ARP_SEASON_CONFIRMED === "true";
  const seasonal = loadSeasonalCycleConfig();
  return [
    { scope: "regular", mode: "regular", arenaMode: null, cycleId: null, primaryMetric: "performance", minimumSample: regularMinimum,
      activityCutoffMs: cutoff, arpSeasonId: null, arpSourceConfirmed: false },
    { scope: "pve", mode: "pve", arenaMode: null, cycleId: null, primaryMetric: "performance", minimumSample: pveMinimum,
      activityCutoffMs: cutoff, arpSeasonId: null, arpSourceConfirmed: false },
    ...ARENA_LEADERBOARD_MODES.map((arenaMode): LeaderboardScopeConfig => ({
      scope: arenaMode === "blastGang" ? `arena:${arenaMode}:${seasonId}` : `arena:${arenaMode}`,
      mode: "arena", cycleId: null,
      arenaMode,
      primaryMetric: arenaMode === "blastGang" ? "arp" : arenaMode === "lastHero" ? "killsPerMatch" : "performance",
      minimumSample: arenaMode === "lastHero" ? lastHeroMinimum : arenaMinimum,
      activityCutoffMs: arenaCutoff,
      arpSeasonId: arenaMode === "blastGang" ? seasonId : null,
      arpSourceConfirmed: arenaMode === "blastGang" && confirmed,
    })),
    ...(seasonal?.enabled ? [{
      scope: `seasonal:${seasonal.cycleId}`, mode: "pvp-season" as const, arenaMode: null,
      cycleId: seasonal.cycleId, primaryMetric: "performance" as const,
      minimumSample: integerEnv("LEADERBOARD_SEASONAL_MINIMUM_RAIDS", 6),
      activityCutoffMs: Math.max(cutoff, seasonal.startsAt), arpSeasonId: null, arpSourceConfirmed: false,
    }] : []),
  ];
}

export function leaderboardScope(mode: LeaderboardMode, arenaMode: ArenaModeKey | null): LeaderboardScopeConfig | null {
  return leaderboardScopeConfigs().find((entry) => entry.mode === mode && entry.arenaMode === arenaMode) ?? null;
}

export function leaderboardConfigChanged(saved: SavedLeaderboardParams | null | undefined, config: LeaderboardScopeConfig): boolean {
  return !saved || saved.scope !== config.scope || saved.mode !== config.mode || saved.arenaMode !== config.arenaMode ||
    saved.cycleId !== config.cycleId ||
    saved.primaryMetric !== config.primaryMetric || saved.minimumSample !== config.minimumSample ||
    saved.activityCutoffMs !== config.activityCutoffMs || saved.arpSeasonId !== config.arpSeasonId ||
    saved.arpSourceConfirmed !== config.arpSourceConfirmed;
}

export function leaderboardFullReason(input: {
  current: { formulaVersion: number; params: SavedLeaderboardParams } | null;
  config: LeaderboardScopeConfig;
  formulaVersion: number;
  metricVersion: number;
  exclusionFingerprint: string;
  forceFull: boolean;
  journalCreated: boolean;
}): string | null {
  if (input.forceFull) return "requested";
  if (input.journalCreated) return "journal_initialized";
  if (!input.current) return "initial";
  if (leaderboardConfigChanged(input.current.params, input.config)) return "config";
  if (input.current.formulaVersion !== input.formulaVersion) return "formula_version";
  if (input.current.params.metricVersion !== input.metricVersion) return "metric_version";
  if (input.current.params.exclusionFingerprint !== input.exclusionFingerprint) return "exclusions";
  return null;
}
