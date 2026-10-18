import type { ComparisonScope, ComparisonScopeResolution } from "../types/comparison";
import { normalizeCycleId } from "../types/seasonal";
import { ARENA_MODE_KEYS, type ArenaStoredMode } from "../types/arena";

const ARENA_SCOPES = new Set<string>(["overall", ...ARENA_MODE_KEYS]);
type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function unavailableScope(): ComparisonScopeResolution {
  return { status: "unavailable", scope: null };
}

function uniqueSearchParams(input: string | URLSearchParams): URLSearchParams | null {
  const params = typeof input === "string" ? new URLSearchParams(input) : new URLSearchParams(input);
  for (const key of ["mode", "cycle", "arenaMode"]) {
    if (params.getAll(key).length > 1) return null;
  }
  return params;
}

function validPinnedCycle(value: string | null): value is string {
  return value !== null && normalizeCycleId(value, "seasonal") === value;
}

export function parseComparisonScope(
  input: string | URLSearchParams,
  seasonalCycleId: string | null,
): ComparisonScopeResolution {
  const params = uniqueSearchParams(input);
  if (!params) return unavailableScope();
  const rawMode = params.get("mode");
  const mode = rawMode === null ? "regular" : rawMode;
  const rawCycle = params.get("cycle");
  const rawArenaMode = params.get("arenaMode");

  if (mode === "regular" || mode === "pve") {
    if (rawCycle !== null && rawCycle !== "persistent") return unavailableScope();
    if (rawArenaMode !== null) return unavailableScope();
    return { status: "available", scope: { mode, cycleId: "persistent", arenaMode: null } };
  }
  if (mode === "arena") {
    if (rawCycle !== null && rawCycle !== "persistent") return unavailableScope();
    if (rawArenaMode !== null && !ARENA_SCOPES.has(rawArenaMode)) return unavailableScope();
    return { status: "available", scope: { mode: "arena", cycleId: "persistent", arenaMode: (rawArenaMode ?? "overall") as ArenaStoredMode } };
  }
  if (mode !== "seasonal" || !validPinnedCycle(seasonalCycleId)) return unavailableScope();
  if (rawCycle !== null && rawCycle !== seasonalCycleId) return unavailableScope();
  if (rawArenaMode !== null) return unavailableScope();
  return { status: "available", scope: { mode: "seasonal", cycleId: seasonalCycleId, arenaMode: null } };
}

export function isComparisonScope(value: unknown): value is ComparisonScope {
  const scope = record(value);
  if (!scope) return false;
  if (scope.mode === "arena") {
    return scope.cycleId === "persistent" && typeof scope.arenaMode === "string" && ARENA_SCOPES.has(scope.arenaMode);
  }
  if (scope.mode !== "regular" && scope.mode !== "pve" && scope.mode !== "seasonal") return false;
  if (scope.arenaMode !== null || typeof scope.cycleId !== "string") return false;
  return scope.mode === "seasonal"
    ? normalizeCycleId(scope.cycleId, "seasonal") === scope.cycleId
    : scope.cycleId === "persistent";
}
