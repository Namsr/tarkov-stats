import {
  ARENA_COMPARISON_METRIC_KEYS,
  PERSISTENT_COMPARISON_METRIC_KEYS,
  type ArenaComparisonBenchmarks,
  type ArenaComparisonMetrics,
  type ComparisonActualRanges,
  type ComparisonBenchmark,
  type ComparisonCohort,
  type ComparisonCohortQuality,
  type ComparisonCohortReason,
  type ComparisonIdentity,
  type ComparisonPercentile,
  type ComparisonProfile,
  type ComparisonProfileUrlOptions,
  type ComparisonRange,
  type ComparisonScope,
  type ComparisonScopeResolution,
  type PersistentComparisonBenchmarks,
  type PersistentComparisonMetrics,
  type PersistentComparisonPercentiles,
} from "../types/comparison";
import { normalizeCycleId } from "../types/seasonal";

const PERSISTENT_PROFILE_FIELDS = {
  kd_ratio: "kdRatio",
  pmc_kd_ratio: "pmcKdRatio",
  kills_per_raid: "killsPerRaid",
  pmc_survival_rate: "pmcSurvivalRate",
  longest_win_streak: "longestWinStreak",
  level: "level",
} as const;

const COHORT_PERCENTS = new Set([10, 15, 20, 30]);
const COHORT_REASONS = new Set<ComparisonCohortReason>([
  "no_activity",
  "target_unavailable",
  "insufficient_cohort",
]);

type UnknownRecord = Record<string, unknown>;
type MetricValueResult = { ok: true; value: number | null } | { ok: false };

function record(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function unavailableScope(): ComparisonScopeResolution {
  return { status: "unavailable", scope: null };
}

function validAid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function metricValue(value: unknown, missingIsNull = false): MetricValueResult {
  if (value === null || (missingIsNull && value === undefined)) return { ok: true, value: null };
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return { ok: false };
  return { ok: true, value };
}

function countValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
    if (rawArenaMode !== null && rawArenaMode !== "overall") return unavailableScope();
    return { status: "available", scope: { mode: "arena", cycleId: "persistent", arenaMode: "overall" } };
  }
  if (mode !== "seasonal" || !validPinnedCycle(seasonalCycleId)) return unavailableScope();
  if (rawCycle !== null && rawCycle !== seasonalCycleId) return unavailableScope();
  if (rawArenaMode !== null) return unavailableScope();
  return { status: "available", scope: { mode: "seasonal", cycleId: seasonalCycleId, arenaMode: null } };
}

function isComparisonScope(value: unknown): value is ComparisonScope {
  const scope = record(value);
  if (!scope) return false;
  if (scope.mode === "arena") {
    return scope.cycleId === "persistent" && scope.arenaMode === "overall";
  }
  if (scope.mode !== "regular" && scope.mode !== "pve" && scope.mode !== "seasonal") return false;
  if (scope.arenaMode !== null || typeof scope.cycleId !== "string") return false;
  return scope.mode === "seasonal"
    ? normalizeCycleId(scope.cycleId, "seasonal") === scope.cycleId
    : scope.cycleId === "persistent";
}

function requireScope(scope: ComparisonScope): void {
  if (!isComparisonScope(scope)) throw new TypeError("Invalid comparison scope");
}

export function buildComparisonProfileUrl(
  scope: ComparisonScope,
  aid: number,
  options: ComparisonProfileUrlOptions = {},
): string {
  requireScope(scope);
  if (!validAid(aid)) throw new TypeError("Invalid comparison account id");
  const params = new URLSearchParams({
    aid: String(aid),
    mode: scope.mode,
    cycle: scope.cycleId,
  });
  if (options.refresh === true) params.set("refresh", "1");
  return `/api/player/profile?${params.toString()}`;
}

export function buildComparisonCohortUrl(scope: ComparisonScope, aid: number): string {
  requireScope(scope);
  if (!validAid(aid)) throw new TypeError("Invalid comparison account id");
  const endpoint = scope.mode === "seasonal" ? "/api/seasonal/cohort" : "/api/average/cohort";
  const params = new URLSearchParams({
    aid: String(aid),
    mode: scope.mode,
    cycle: scope.cycleId,
    statistic: "median",
    period: scope.mode === "regular" ? "90d" : "all",
  });
  if (scope.mode === "arena") params.set("arenaMode", scope.arenaMode);
  return `${endpoint}?${params.toString()}`;
}

function normalizedIdentity(
  body: UnknownRecord,
  scope: ComparisonScope,
  aid: number,
  requireArenaMode: boolean,
): ComparisonIdentity | null {
  const identity = record(body.identity);
  if (!identity || identity.aid !== aid || identity.mode !== scope.mode || identity.cycleId !== scope.cycleId) {
    return null;
  }
  if (scope.mode === "arena") {
    if (requireArenaMode && identity.arenaMode !== scope.arenaMode) return null;
    if (identity.arenaMode !== undefined && identity.arenaMode !== scope.arenaMode) return null;
    return { aid, mode: "arena", cycleId: "persistent", arenaMode: "overall" };
  }
  if (identity.arenaMode !== undefined && identity.arenaMode !== null) return null;
  if (scope.mode === "seasonal") {
    return { aid, mode: "seasonal", cycleId: scope.cycleId, arenaMode: null };
  }
  return { aid, mode: scope.mode, cycleId: "persistent", arenaMode: null };
}

function persistentMetrics(source: UnknownRecord): PersistentComparisonMetrics | null {
  if (source.pvpStatsKnown !== undefined && typeof source.pvpStatsKnown !== "boolean") return null;
  const pvpStatsKnown = source.pvpStatsKnown !== false;
  const output = {} as PersistentComparisonMetrics;
  for (const key of PERSISTENT_COMPARISON_METRIC_KEYS) {
    const parsed = metricValue(source[PERSISTENT_PROFILE_FIELDS[key]], true);
    if (!parsed.ok) return null;
    output[key] = pvpStatsKnown || (key !== "pmc_kd_ratio" && key !== "pmc_survival_rate")
      ? parsed.value
      : null;
  }
  return output;
}

function arenaMetrics(source: UnknownRecord): ArenaComparisonMetrics | null {
  const output = {} as ArenaComparisonMetrics;
  for (const key of ARENA_COMPARISON_METRIC_KEYS) {
    const parsed = metricValue(source[key], true);
    if (!parsed.ok) return null;
    output[key] = parsed.value;
  }
  return output;
}

function profileNickname(body: UnknownRecord, arena: UnknownRecord | null): string | null {
  if (arena) return textValue(arena.nickname);
  const stats = record(body.stats);
  const profile = record(body.profile);
  const info = record(profile?.info);
  const viewModel = record(body.viewModel);
  const viewIdentity = record(viewModel?.identity);
  return textValue(stats?.nickname)
    ?? textValue(info?.nickname)
    ?? textValue(profile?.nickname)
    ?? textValue(viewIdentity?.nickname);
}

export function adaptComparisonProfile<T extends ComparisonScope>(
  scope: T,
  aid: number,
  payload: unknown,
): ComparisonProfile<T> | null {
  if (!validAid(aid) || !isComparisonScope(scope)) return null;
  const body = record(payload);
  if (!body) return null;
  const identity = normalizedIdentity(body, scope, aid, false);
  if (!identity) return null;

  if (scope.mode === "arena") {
    if (body.arenaStatus === "legacy_incomplete") return null;
    const arena = record(body.arena);
    const overall = record(arena?.overall);
    const metrics = record(overall?.metrics);
    if (!arena || arena.aid !== aid || !metrics) return null;
    const normalized = arenaMetrics(metrics);
    if (!normalized) return null;
    return {
      scope,
      identity,
      nickname: profileNickname(body, arena),
      metrics: normalized,
    } as ComparisonProfile<T>;
  }

  let source: UnknownRecord | null = null;
  if (body.comparisonStats !== undefined && body.comparisonStats !== null) {
    source = record(body.comparisonStats);
    if (!source) return null;
  } else {
    source = record(body.stats);
  }
  if (!source) return null;
  const metrics = persistentMetrics(source);
  if (!metrics) return null;
  return {
    scope,
    identity,
    nickname: profileNickname(body, null),
    metrics,
  } as ComparisonProfile<T>;
}

function benchmark(value: unknown, apply: boolean): ComparisonBenchmark | null {
  const source = record(value);
  if (!source) return null;
  const parsed = metricValue(source.value);
  const count = countValue(source.count);
  if (!parsed.ok || count === null) return null;
  return { value: apply ? parsed.value : null, count };
}

function persistentBenchmarks(
  value: unknown,
  quality: ComparisonCohortQuality,
): PersistentComparisonBenchmarks | null {
  const source = record(value);
  if (!source) return null;
  const output = {} as PersistentComparisonBenchmarks;
  for (const key of PERSISTENT_COMPARISON_METRIC_KEYS) {
    const parsed = benchmark(source[key], quality === "sufficient");
    if (!parsed) return null;
    output[key] = parsed;
  }
  return output;
}

function arenaBenchmarks(
  value: unknown,
  quality: ComparisonCohortQuality,
): ArenaComparisonBenchmarks | null {
  const source = record(value);
  if (!source) return null;
  const output = {} as ArenaComparisonBenchmarks;
  for (const key of ARENA_COMPARISON_METRIC_KEYS) {
    const parsed = benchmark(source[key], quality === "sufficient");
    if (!parsed) return null;
    output[key] = parsed;
  }
  return output;
}

function percentiles(value: unknown, quality: ComparisonCohortQuality): PersistentComparisonPercentiles | null {
  const source = record(value);
  if (!source) return null;
  const output = {} as PersistentComparisonPercentiles;
  for (const key of PERSISTENT_COMPARISON_METRIC_KEYS) {
    const metric = record(source[key]);
    if (!metric) return null;
    const percentile = metricValue(metric.percentile);
    const count = countValue(metric.count);
    const below = countValue(metric.below);
    const equal = countValue(metric.equal);
    if (!percentile.ok || count === null || below === null || equal === null) return null;
    if (percentile.value !== null && percentile.value > 100) return null;
    output[key] = {
      percentile: quality === "sufficient" ? percentile.value : null,
      count,
      below,
      equal,
    } satisfies ComparisonPercentile;
  }
  return output;
}

function range(value: unknown): ComparisonRange | null | undefined {
  if (value === null) return null;
  const source = record(value);
  if (!source) return undefined;
  const min = metricValue(source.min);
  const max = metricValue(source.max);
  if (!min.ok || !max.ok || min.value === null || max.value === null || min.value > max.value) return undefined;
  return { min: min.value, max: max.value };
}

function persistentRanges(value: unknown): ComparisonActualRanges | null {
  const source = record(value);
  if (!source) return null;
  const hours = range(source.hours);
  const pmcRaids = range(source.pmcRaids);
  const raids = source.raids === undefined ? pmcRaids : range(source.raids);
  if (hours === undefined || pmcRaids === undefined || raids === undefined) return null;
  return { hours, pmcRaids, raids };
}

function commonCohort(
  n: unknown,
  required: unknown,
  percent: unknown,
  strategy: unknown,
  quality: unknown,
  reason: unknown,
): {
  n: number;
  required: number;
  percent: 10 | 15 | 20 | 30;
  strategy: "matched" | "population";
  quality: ComparisonCohortQuality;
  reason: ComparisonCohortReason | null;
} | null {
  const sampleN = countValue(n);
  const requiredN = countValue(required);
  if (sampleN === null || requiredN === null || requiredN === 0) return null;
  if (typeof percent !== "number" || !COHORT_PERCENTS.has(percent as 10 | 15 | 20 | 30)) return null;
  if (strategy !== "matched" && strategy !== "population") return null;
  if (quality !== "sufficient" && quality !== "unavailable") return null;
  if (reason !== null && (typeof reason !== "string" || !COHORT_REASONS.has(reason as ComparisonCohortReason))) {
    return null;
  }
  return {
    n: sampleN,
    required: requiredN,
    percent: percent as 10 | 15 | 20 | 30,
    strategy,
    quality,
    reason: reason as ComparisonCohortReason | null,
  };
}

export function adaptComparisonCohort<T extends ComparisonScope>(
  scope: T,
  aid: number,
  payload: unknown,
): ComparisonCohort<T> | null {
  if (!validAid(aid) || !isComparisonScope(scope)) return null;
  const body = record(payload);
  if (!body) return null;
  const identity = normalizedIdentity(body, scope, aid, true);
  if (!identity) return null;

  if (scope.mode === "arena") {
    if (body.gameMode !== "arena" || body.mode !== "overall" || body.aid !== aid) return null;
    if (body.percentiles !== null) return null;
    const common = commonCohort(
      body.sampleN,
      body.required,
      body.percent,
      body.strategy,
      body.quality,
      body.reason,
    );
    const benchmarks = arenaBenchmarks(body.metrics, common?.quality ?? "unavailable");
    if (!common || !benchmarks) return null;
    return {
      scope,
      identity,
      ...common,
      actualRanges: { hours: null, pmcRaids: null, raids: null },
      benchmarks,
      percentiles: null,
    } as ComparisonCohort<T>;
  }

  if (body.twoDimensional !== true) return null;
  if (scope.mode === "seasonal" ? body.percentiles !== null : record(body.percentiles) === null) return null;
  const common = commonCohort(
    body.n,
    body.required,
    body.percent,
    body.strategy,
    body.quality,
    body.reason,
  );
  const benchmarks = persistentBenchmarks(body.averages, common?.quality ?? "unavailable");
  const actualRanges = persistentRanges(body.actualRanges);
  const normalizedPercentiles = scope.mode === "seasonal"
    ? null
    : percentiles(body.percentiles, common?.quality ?? "unavailable");
  if (!common || !benchmarks || !actualRanges || (scope.mode !== "seasonal" && !normalizedPercentiles)) return null;
  return {
    scope,
    identity,
    ...common,
    actualRanges,
    benchmarks,
    percentiles: normalizedPercentiles,
  } as ComparisonCohort<T>;
}

export {
  buildComparisonCohortUrl as comparisonCohortRequestUrl,
  buildComparisonProfileUrl as comparisonProfileRequestUrl,
  parseComparisonScope as comparisonScopeFromSearchParams,
};
