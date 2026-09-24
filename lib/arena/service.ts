import { getArenaBackend, getStore } from "@/lib/db";
import { parseArenaProfileStats } from "@/lib/tarkov-api";
import {
  ARENA_METRIC_KEYS,
  ARENA_MODE_KEYS,
  type ArenaAverageInput,
  type ArenaAverageResult,
  type ArenaCohortResult,
  type ArenaCounters,
  type ArenaDimension,
  type ArenaMetricKey,
  type ArenaMetricValue,
  type ArenaModeKey,
  type ArenaModeRisk,
  type ArenaModeStats,
  type ArenaOverallRisk,
  type ArenaOverallStats,
  type ArenaProfile,
  type ArenaProfileRisk,
  type ArenaRangeBounds,
  type ArenaRiskMetric,
  type ArenaStatistic,
  type ArenaStoredMode,
} from "@/types/arena";
import type { PlayerProfile } from "@/types/tarkov";
import { ARENA_PARSER_VERSION, ARENA_RISK_UPSERT_SQL, arenaRiskValues, isArenaMode } from "@/lib/arena/storage";
import { markAveragePublicationDirty } from "@/lib/average-publication";
import { singleFlight } from "@/lib/seasonal/progression-flight";

export { ARENA_PARSER_VERSION } from "@/lib/arena/storage";

type Backend = NonNullable<Awaited<ReturnType<typeof getArenaBackend>>>;
type Row = Record<string, unknown>;

const COHORT_PERCENTS = [10, 15, 20, 30] as const;
const RISK_METRICS = ["kd_ratio", "win_rate", "kills_per_match", "damage_per_match"] as const;
// Peer scans below read only the selected numeric metrics.
const ARENA_RISK_PROJECTION = "aid, arena_mode, hours, games_count, kd_ratio, win_rate, kills_per_match, damage_per_match, upstream_version, parser_version, fetched_at";
export const ARENA_RISK_CALCULATION_VERSION = 3;
/** Stored Arena risk is reused for cache hits; background refresh keeps it fresh. */
export const ARENA_RISK_TTL_MS = 5 * 60 * 60 * 1000;

export function parseArenaProfile(profile: PlayerProfile): ArenaProfile {
  const parsed = parseArenaProfileStats(profile).arenaProfile;
  if (!parsed) throw new Error("Arena profile parsing failed");
  return parsed;
}

/** Parses and atomically writes both the legacy envelope and normalized Arena rows. */
export async function persistArenaProfile(profile: PlayerProfile): Promise<ArenaProfile> {
  const stats = parseArenaProfileStats(profile);
  const arena = stats.arenaProfile;
  if (!arena) throw new Error("Arena profile parsing failed");
  const store = await getStore("arena");
  if (!store) throw new Error("Arena storage unavailable");
  await store.upsert(profile.aid, stats, profile.achievements ? Object.keys(profile.achievements) : []);
  await markAveragePublicationDirty("arena");
  return arena;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegative(value: unknown): number | null {
  const number = numberOrNull(value);
  return number !== null && number >= 0 ? number : null;
}

async function all(backend: Backend, sql: string, params: unknown[] = []): Promise<Row[]> {
  if (backend.kind === "d1") {
    const result = await backend.db.prepare(sql).bind(...params).all();
    return (result.results ?? []) as Row[];
  }
  return backend.db.prepare(sql).all(...params) as Row[];
}

async function run(backend: Backend, sql: string, params: unknown[] = []): Promise<void> {
  if (backend.kind === "d1") {
    await backend.db.prepare(sql).bind(...params).run();
  } else {
    backend.db.prepare(sql).run(...params);
  }
}

function emptyMetrics(): Record<ArenaMetricKey, ArenaMetricValue> {
  return Object.fromEntries(ARENA_METRIC_KEYS.map((metric) => [metric, {
    value: null, count: 0, reason: "no_valid_values",
  }])) as
    Record<ArenaMetricKey, ArenaMetricValue>;
}

function statistic(values: number[], kind: ArenaStatistic): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (kind === "median") {
    const upper = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[upper] : (sorted[upper - 1] + sorted[upper]) / 2;
  }
  const trim = sorted.length >= 20 ? Math.floor(sorted.length * 0.05) : 0;
  const window = trim > 0 ? sorted.slice(trim, sorted.length - trim) : sorted;
  return window.reduce((sum, value) => sum + value, 0) / window.length;
}

function metricValues(rows: Row[], metric: ArenaMetricKey): number[] {
  return rows.map((row) => numberOrNull(row[metric])).filter((value): value is number => value !== null);
}

function metricSummary(rows: Row[], kind: ArenaStatistic, minimum = 0): Record<ArenaMetricKey, ArenaMetricValue> {
  const output = emptyMetrics();
  for (const metric of ARENA_METRIC_KEYS) {
    const values = metricValues(rows, metric);
    output[metric] = {
      value: values.length >= minimum ? statistic(values, kind) : null,
      count: values.length,
      reason: values.length === 0 ? "no_valid_values" : values.length < minimum ? "insufficient_values" : null,
    };
  }
  return output;
}

function bounds(rows: Row[], key: "hours" | "games_count"): ArenaRangeBounds {
  const values = rows.map((row) => numberOrNull(row[key])).filter((value): value is number => value !== null);
  return values.length ? { min: Math.min(...values), max: Math.max(...values) } : { min: null, max: null };
}

function validateLimit(value: number | null | undefined, name: string): number | null {
  if (value == null) return null;
  if (!Number.isFinite(value) || value < 0) throw new Error(`invalid ${name}`);
  return value;
}

function averageIdentity(input: ArenaAverageInput) {
  const mode = input.mode;
  if (mode !== "overall" && !isArenaMode(mode)) throw new Error("invalid arena mode");
  const statistic = input.statistic ?? "trimmed_mean";
  if (statistic !== "trimmed_mean" && statistic !== "median") throw new Error("invalid arena statistic");
  const dimension = input.dimension ?? "matches";
  if (dimension !== "hours" && dimension !== "matches") throw new Error("invalid arena dimension");
  const metric = input.metric ?? "players";
  if (metric !== "players" && !ARENA_METRIC_KEYS.includes(metric)) throw new Error("invalid arena metric");
  const minHours = validateLimit(input.minHours, "minimum hours");
  const maxHours = validateLimit(input.maxHours, "maximum hours");
  const minMatches = validateLimit(input.minMatches, "minimum matches");
  const maxMatches = validateLimit(input.maxMatches, "maximum matches");
  if ((minHours !== null && maxHours !== null && minHours > maxHours) ||
      (minMatches !== null && maxMatches !== null && minMatches > maxMatches)) {
    throw new Error("invalid arena range");
  }
  return { mode, statistic, dimension, metric, minHours, maxHours, minMatches, maxMatches };
}

function arenaWhere(input: {
  mode: ArenaStoredMode;
  aid?: number;
  exceptAid?: number;
  minHours?: number | null;
  maxHours?: number | null;
  minMatches?: number | null;
  maxMatches?: number | null;
  eligible?: boolean;
}) {
  const where = ["arena_mode = ?", "NOT EXISTS (SELECT 1 FROM excluded_players tombstone WHERE tombstone.aid = arena_mode_stats.aid)"];
  const params: unknown[] = [input.mode];
  if (input.aid !== undefined) { where.push("aid = ?"); params.push(input.aid); }
  if (input.exceptAid !== undefined) { where.push("aid != ?"); params.push(input.exceptAid); }
  if (input.eligible) {
    where.push("games_count >= 10", "parser_version = ?");
    params.push(ARENA_PARSER_VERSION);
  }
  if (input.minHours != null) { where.push("hours >= ?"); params.push(input.minHours); }
  if (input.maxHours != null) { where.push("hours <= ?"); params.push(input.maxHours); }
  if (input.minMatches != null) { where.push("games_count >= ?"); params.push(input.minMatches); }
  if (input.maxMatches != null) { where.push("games_count <= ?"); params.push(input.maxMatches); }
  return { where: `WHERE ${where.join(" AND ")}`, params };
}

async function arenaRows(backend: Backend, input: Parameters<typeof arenaWhere>[0]): Promise<Row[]> {
  const condition = arenaWhere(input);
  return all(backend, `SELECT aid, hours, games_count, kd_ratio, win_rate, headshot_rate,
    kills_per_match, damage_per_match, upstream_version, parser_version, fetched_at
    FROM arena_mode_stats ${condition.where}`, condition.params);
}

async function arenaPopulation(backend: Backend): Promise<ArenaAverageResult["population"]> {
  const rows = await all(backend, `SELECT arena_mode,
      COUNT(DISTINCT CASE WHEN arena_mode = 'overall' THEN aid END) AS scanned_accounts,
      COUNT(DISTINCT CASE WHEN arena_mode <> 'overall'
        AND typeof(games_count) = 'integer' AND games_count >= 1 THEN aid END) AS played_accounts
    FROM arena_mode_stats
    WHERE parser_version = ?
      AND NOT EXISTS (
        SELECT 1 FROM excluded_players tombstone
        WHERE tombstone.aid = arena_mode_stats.aid
      )
    GROUP BY arena_mode`, [ARENA_PARSER_VERSION]);
  const playedAccounts = Object.fromEntries(ARENA_MODE_KEYS.map((mode) => [mode, 0])) as Record<ArenaModeKey, number>;
  let scannedAccounts = 0;
  for (const row of rows) {
    const mode = String(row.arena_mode);
    if (mode === "overall") {
      scannedAccounts = Number(row.scanned_accounts) || 0;
    } else if (isArenaMode(mode)) {
      playedAccounts[mode] = Number(row.played_accounts) || 0;
    }
  }
  return { scannedAccounts, playedAccounts };
}

function bucketFor(value: number, dimension: ArenaDimension): { min: number; max: number | null } {
  if (dimension === "hours") {
    if (value >= 10_000) return { min: 10_000, max: null };
    const size = value < 2_000 ? 50 : 100;
    const min = value < 2_000 ? Math.floor(value / size) * size : 2_000 + Math.floor((value - 2_000) / size) * size;
    return { min, max: min + size };
  }
  if (value >= 3_000) return { min: 3_000, max: null };
  const size = value < 1_000 ? 25 : 50;
  const min = value < 1_000 ? Math.floor(value / size) * size : 1_000 + Math.floor((value - 1_000) / size) * size;
  return { min, max: min + size };
}

function averageBuckets(rows: Row[], dimension: ArenaDimension, kind: ArenaStatistic) {
  const groups = new Map<string, { min: number; max: number | null; rows: Row[] }>();
  const key = dimension === "hours" ? "hours" : "games_count";
  for (const row of rows) {
    const value = numberOrNull(row[key]);
    if (value === null) continue;
    const range = bucketFor(value, dimension);
    const id = `${range.min}:${range.max ?? "plus"}`;
    const bucket = groups.get(id) ?? { ...range, rows: [] };
    bucket.rows.push(row);
    groups.set(id, bucket);
  }
  return [...groups.values()]
    .sort((left, right) => left.min - right.min)
    .map((bucket) => ({ min: bucket.min, max: bucket.max, sampleN: bucket.rows.length, metrics: metricSummary(bucket.rows, kind) }));
}

export async function getArenaAverage(input: ArenaAverageInput): Promise<ArenaAverageResult | null> {
  const backend = await getArenaBackend();
  if (!backend) return null;
  const filterIdentity = averageIdentity(input);
  const [rows, population] = await Promise.all([
    arenaRows(backend, { ...filterIdentity, eligible: true }),
    arenaPopulation(backend),
  ]);
  const metrics = metricSummary(rows, filterIdentity.statistic);
  const matchValues = rows.map((row) => numberOrNull(row.games_count)).filter((value): value is number => value !== null && value >= 0);
  return {
    filterIdentity,
    sampleN: rows.length,
    total: rows.length,
    coverage: Object.fromEntries(ARENA_METRIC_KEYS.map((metric) => [
      metric, rows.length ? metrics[metric].count / rows.length : 0,
    ])) as Record<ArenaMetricKey, number>,
    bounds: { hours: bounds(rows, "hours"), matches: bounds(rows, "games_count") },
    metrics,
    averageMatches: matchesSummaryFromValues(matchValues, filterIdentity.statistic, 0),
    buckets: averageBuckets(rows, filterIdentity.dimension, filterIdentity.statistic),
    population,
  };
}

function proportionalBounds(center: number, percent: 10 | 15 | 20 | 30): ArenaRangeBounds {
  const ratio = percent / 100;
  return { min: Math.max(0, center * (1 - ratio)), max: center * (1 + ratio) };
}

function emptyMatches(): ArenaAverageResult["averageMatches"] {
  return { value: null, count: 0, reason: "no_valid_values" };
}

function matchesSummaryFromValues(values: number[], kind: ArenaStatistic, minimum = 20): ArenaAverageResult["averageMatches"] {
  return {
    value: values.length >= minimum ? statistic(values, kind) : null,
    count: values.length,
    reason: values.length === 0 ? "no_valid_values" : values.length < minimum ? "insufficient_values" : null,
  };
}

function emptyCohort(aid: number, mode: ArenaStoredMode, statistic: ArenaStatistic): ArenaCohortResult {
  const common = {
    aid, statistic, target: { hours: null, matches: null }, percent: 30 as const,
    sampleN: 0, required: 20, quality: "unavailable" as const, reason: "target_unavailable" as const, metrics: emptyMetrics(),
    averageMatches: emptyMatches(),
  };
  if (mode === "overall") {
    return {
      ...common, mode, strategy: "population",
      bounds: { hours: { min: null, max: null }, matches: { min: 10, max: null } },
    };
  }
  return {
    ...common, mode, strategy: "matched",
    bounds: { hours: { min: null, max: null }, matches: { min: null, max: null } },
  };
}

type MetricSamples = { sampleN: number; values: Map<ArenaMetricKey, number[]> };

/** Stream narrow rows into numeric columns, without retaining a peer object graph. */
async function arenaMetricSamples(
  backend: Backend, sql: string, params: unknown[], metrics: readonly ArenaMetricKey[],
): Promise<Map<string, MetricSamples>> {
  const result = new Map<string, MetricSamples>();
  const append = (mode: string, read: (index: number, metric: ArenaMetricKey) => unknown) => {
    let group = result.get(mode);
    if (!group) {
      group = { sampleN: 0, values: new Map(metrics.map((metric) => [metric, []])) };
      result.set(mode, group);
    }
    group.sampleN++;
    for (let index = 0; index < metrics.length; index++) {
      const metric = metrics[index];
      const value = numberOrNull(read(index, metric));
      if (value !== null) group.values.get(metric)!.push(value);
    }
  };
  if (backend.kind === "sqlite") {
    const statement = backend.db.prepare(sql);
    // Available in Node 22.16+. Older SQLite runners retain the object-row path.
    const arrays = typeof statement.setReturnArrays === "function";
    if (arrays) statement.setReturnArrays(true);
    for (const row of statement.iterate(...params)) {
      append(String(arrays ? row[0] : row.arena_mode), (index, metric) => arrays ? row[index + 1] : row[metric]);
    }
  } else {
    for (const row of await all(backend, sql, params)) append(String(row.arena_mode), (_index, metric) => row[metric]);
  }
  return result;
}

async function arenaCohortSummary(
  backend: Backend,
  input: Parameters<typeof arenaWhere>[0],
  kind: ArenaStatistic,
): Promise<{ sampleN: number; metrics: Record<ArenaMetricKey, ArenaMetricValue>; averageMatches: ArenaAverageResult["averageMatches"] }> {
  const condition = arenaWhere(input);
  const groups = await arenaMetricSamples(backend,
    `SELECT arena_mode, ${ARENA_METRIC_KEYS.join(", ")} FROM arena_mode_stats ${condition.where}`,
    condition.params, ARENA_METRIC_KEYS);
  const group = groups.get(input.mode);
  const metrics = emptyMetrics();
  for (const metric of ARENA_METRIC_KEYS) {
    const values = group?.values.get(metric) ?? [];
    metrics[metric] = {
      value: values.length >= 20 ? statistic(values, kind) : null, count: values.length,
      reason: values.length === 0 ? "no_valid_values" : values.length >= 20 ? null : "insufficient_values",
    };
  }
  const matchCondition = arenaWhere(input);
  const matchRows = await all(backend,
    `SELECT games_count FROM arena_mode_stats ${matchCondition.where}`,
    matchCondition.params);
  const matchValues = matchRows.map((row) => numberOrNull(row.games_count)).filter((value): value is number => value !== null && value >= 0);
  return { sampleN: group?.sampleN ?? matchRows.length, metrics, averageMatches: matchesSummaryFromValues(matchValues, kind) };
}

function arenaRangeCountQuery(aid: number, mode: ArenaStoredMode, hours: number, matches: number) {
  const ranges = COHORT_PERCENTS.map((percent) => ({
    hours: proportionalBounds(hours, percent), matches: proportionalBounds(matches, percent),
  }));
  const widest = ranges[ranges.length - 1];
  const condition = arenaWhere({ mode, exceptAid: aid, eligible: true,
    minHours: widest.hours.min, maxHours: widest.hours.max,
    minMatches: widest.matches.min, maxMatches: widest.matches.max });
  return { sql: `SELECT '${mode}' AS arena_mode, ${COHORT_PERCENTS.map((percent) =>
    `SUM(CASE WHEN hours BETWEEN ? AND ? AND games_count BETWEEN ? AND ? THEN 1 ELSE 0 END) AS n${percent}`
  ).join(", ")} FROM arena_mode_stats ${condition.where}`, params: [
    ...ranges.flatMap((range) => [range.hours.min, range.hours.max, range.matches.min, range.matches.max]),
    ...condition.params,
  ] };
}

function arenaSelectedRange(counts: Row | undefined, minimum: number) {
  const percent = COHORT_PERCENTS.find((p) => Number(counts?.[`n${p}`] ?? 0) >= minimum) ?? 30;
  return { percent, sampleN: Number(counts?.[`n${percent}`] ?? 0) };
}

export async function getArenaCohort(
  aid: number,
  arenaMode: ArenaStoredMode,
  statisticKind: ArenaStatistic = "trimmed_mean",
): Promise<ArenaCohortResult | null> {
  if (!Number.isSafeInteger(aid) || aid <= 0 || (arenaMode !== "overall" && !isArenaMode(arenaMode)) ||
      (statisticKind !== "trimmed_mean" && statisticKind !== "median")) throw new Error("invalid arena cohort");
  const backend = await getArenaBackend();
  if (!backend) return null;
  const target = (await arenaRows(backend, { mode: arenaMode, aid }))[0];
  const targetHours = numberOrNull(target?.hours);
  const targetMatches = numberOrNull(target?.games_count);
  if (!target || numberOrNull(target.parser_version) !== ARENA_PARSER_VERSION ||
      targetMatches === null || targetMatches < 10 || (arenaMode !== "overall" && targetHours === null)) {
    return emptyCohort(aid, arenaMode, statisticKind);
  }
  if (arenaMode === "overall") {
    const summary = await arenaCohortSummary(backend, { mode: "overall", exceptAid: aid, eligible: true }, statisticKind);
    return {
      aid,
      mode: "overall",
      strategy: "population",
      statistic: statisticKind,
      target: { hours: targetHours, matches: targetMatches },
      percent: 30,
      bounds: { hours: { min: null, max: null }, matches: { min: 10, max: null } },
      sampleN: summary.sampleN,
      required: 20,
      quality: summary.sampleN >= 20 ? "sufficient" : "unavailable",
      reason: summary.sampleN >= 20 ? null : "insufficient_cohort",
      metrics: summary.metrics,
      averageMatches: summary.averageMatches,
    };
  }
  if (targetHours === null || targetMatches === null) return emptyCohort(aid, arenaMode, statisticKind);
  const countQuery = arenaRangeCountQuery(aid, arenaMode, targetHours, targetMatches);
  const selected = arenaSelectedRange((await all(backend, countQuery.sql, countQuery.params))[0], 20);
  const hours = proportionalBounds(targetHours, selected.percent);
  const matches = proportionalBounds(targetMatches, selected.percent);
  if (selected.sampleN < 20) {
    return {
      ...emptyCohort(aid, arenaMode, statisticKind),
      target: { hours: targetHours, matches: targetMatches },
      bounds: { hours, matches },
      sampleN: selected.sampleN,
      reason: "insufficient_cohort",
    };
  }
  const summary = await arenaCohortSummary(backend, {
    mode: arenaMode, exceptAid: aid, eligible: true,
    minHours: hours.min, maxHours: hours.max, minMatches: matches.min, maxMatches: matches.max,
  }, statisticKind);
  if (summary.sampleN < 20) {
    return { ...emptyCohort(aid, arenaMode, statisticKind),
      percent: selected.percent,
      target: { hours: targetHours, matches: targetMatches }, bounds: { hours, matches },
      sampleN: summary.sampleN, reason: "insufficient_cohort" };
  }
  return {
    aid,
    mode: arenaMode,
    strategy: "matched",
    statistic: statisticKind,
    target: { hours: targetHours, matches: targetMatches },
    percent: selected.percent,
    bounds: { hours, matches },
    sampleN: summary.sampleN,
    required: 20,
    quality: "sufficient",
    reason: null,
    metrics: summary.metrics,
    averageMatches: summary.averageMatches,
  };
}

function countersFrom(row: Row): ArenaCounters {
  return {
    matches: nonNegative(row.games_count), wins: nonNegative(row.arena_wins), losses: nonNegative(row.arena_losses),
    kills: nonNegative(row.kills), deaths: nonNegative(row.deaths), assists: nonNegative(row.assists),
    headshots: nonNegative(row.headshots), damage: nonNegative(row.damage_dealt),
    round_mvp: nonNegative(row.round_mvp_count), match_mvp: nonNegative(row.match_mvp_count),
    current_kill_streak: nonNegative(row.current_kill_streak), max_kill_streak: nonNegative(row.max_kill_streak),
    current_win_streak: nonNegative(row.current_win_streak), max_win_streak: nonNegative(row.max_win_streak),
    current_loss_streak: nonNegative(row.current_loss_streak), max_loss_streak: nonNegative(row.max_loss_streak),
  };
}

function modeFrom(row: Row, mode: ArenaModeKey): ArenaModeStats {
  return {
    mode,
    hours: null,
    counters: countersFrom(row),
    metrics: Object.fromEntries(ARENA_METRIC_KEYS.map((metric) => [metric, numberOrNull(row[metric])])) as ArenaModeStats["metrics"],
  };
}

function sourceFrom(row: Row): ArenaOverallStats["source"] {
  try {
    const raw = JSON.parse(String(row.raw_json));
    const source = raw?.normalized?.source ?? raw?.source;
    return source === "upstream" || source === "complete_mode_sum" || source === "unavailable" ? source : "unavailable";
  } catch {
    return "unavailable";
  }
}

/** Reads only the normalized Arena snapshot. Legacy four-mode `stats_json` never fills it. */
export async function getArenaProfile(aid: number): Promise<ArenaProfile | null> {
  if (!Number.isSafeInteger(aid) || aid <= 0) throw new Error("invalid arena account id");
  const backend = await getArenaBackend();
  if (!backend) return null;
  const rows = await all(backend, `SELECT arena_mode_stats.*, mode_players.nickname
    FROM arena_mode_stats LEFT JOIN mode_players ON mode_players.mode = 'arena' AND mode_players.aid = arena_mode_stats.aid
    WHERE arena_mode_stats.aid = ?
      AND NOT EXISTS (SELECT 1 FROM excluded_players tombstone WHERE tombstone.aid = arena_mode_stats.aid)`, [aid]);
  const byMode = new Map(rows.map((row) => [String(row.arena_mode), row]));
  const overall = byMode.get("overall");
  if (!overall || !ARENA_MODE_KEYS.every((mode) => byMode.has(mode))) return null;
  const profileUpdatedAt = numberOrNull(overall.upstream_version) ?? 0;
  const parserVersion = numberOrNull(overall.parser_version) ?? ARENA_PARSER_VERSION;
  return {
    aid,
    nickname: typeof overall.nickname === "string" && overall.nickname ? overall.nickname : "Unknown",
    profileUpdatedAt,
    fetchedAt: numberOrNull(overall.fetched_at),
    parserVersion,
    overall: {
      hours: numberOrNull(overall.hours),
      counters: countersFrom(overall),
      metrics: Object.fromEntries(ARENA_METRIC_KEYS.map((metric) => [metric, numberOrNull(overall[metric])])) as ArenaOverallStats["metrics"],
      bestArp: numberOrNull(overall.best_arp),
      source: sourceFrom(overall),
    },
    modes: Object.fromEntries(ARENA_MODE_KEYS.map((mode) => [mode, modeFrom(byMode.get(mode)!, mode)])) as ArenaProfile["modes"],
  };
}

function emptyRiskMetric(reason: ArenaRiskMetric["reason"]): ArenaRiskMetric {
  return { value: null, count: 0, mean: null, std: null, z: null, points: null, available: false, reason };
}

function riskTier(score: number): NonNullable<ArenaProfileRisk["tier"]> {
  if (score < 20) return "low";
  if (score < 45) return "medium";
  if (score < 70) return "high";
  return "severe";
}

function riskModeUnavailable(
  mode: ArenaModeKey,
  reason: string,
  peerCount = 0,
  percent: 10 | 15 | 20 | 30 = 30,
): ArenaModeRisk {
  return {
    mode, score: null, peerCount, percent, reasons: [reason],
    metrics: Object.fromEntries(RISK_METRICS.map((metric) => [metric, emptyRiskMetric(
      reason === "insufficient_peers" ? "insufficient_peers" : "missing_metric"
    )])) as ArenaModeRisk["metrics"],
  };
}

function riskOverallUnavailable(reason: string, peerCount = 0): ArenaOverallRisk {
  return {
    mode: "overall", score: null, peerCount, reasons: [reason],
    metrics: Object.fromEntries(RISK_METRICS.map((metric) => [metric, emptyRiskMetric(
      reason === "insufficient_peers" ? "insufficient_peers" : "missing_metric"
    )])) as ArenaOverallRisk["metrics"],
  };
}

type RiskMetricStats = { count: number; mean: number | null; std: number | null };
type RiskSamples = { sampleN: number; percent: 10 | 15 | 20 | 30; metrics: Map<ArenaMetricKey, RiskMetricStats> };

function stableMean(values: number[]): number {
  const anchor = values.reduce((minimum, value) => Math.min(minimum, value), Number.POSITIVE_INFINITY);
  return anchor + values.reduce((sum, value) => sum + (value - anchor), 0) / values.length;
}

function riskStatsFromSamples(group: MetricSamples | undefined): Map<ArenaMetricKey, RiskMetricStats> {
  const metrics = new Map<ArenaMetricKey, RiskMetricStats>();
  for (const metric of RISK_METRICS) {
    const values = group?.values.get(metric) ?? [];
    if (values.length === 0) {
      metrics.set(metric, { count: 0, mean: null, std: null });
      continue;
    }
    const mean = stableMean(values);
    const identical = values.every((entry) => entry === values[0]);
    const variance = identical ? 0 : Math.max(0, values.reduce((sum, entry) => sum + (entry - mean) ** 2, 0) / values.length);
    metrics.set(metric, { count: values.length, mean, std: Math.sqrt(variance) });
  }
  return metrics;
}

function riskMetrics(target: Row, summary: RiskSamples | undefined): Pick<ArenaModeRisk, "score" | "reasons" | "metrics"> {
  const metrics = {} as ArenaModeRisk["metrics"];
  const points: number[] = [];
  for (const metric of RISK_METRICS) {
    const value = numberOrNull(target[metric]);
    const sample = summary?.metrics.get(metric);
    const count = sample?.count ?? 0;
    if (value === null) {
      metrics[metric] = { ...emptyRiskMetric("missing_metric"), count };
      continue;
    }
    if (count < 30 || sample?.mean == null || sample.std == null) {
      metrics[metric] = { ...emptyRiskMetric("insufficient_peers"), value, count };
      continue;
    }
    const { mean, std } = sample;
    if (std === 0) {
      metrics[metric] = { value, count, mean, std, z: null, points: null, available: false, reason: "zero_std" };
      continue;
    }
    const z = (value - mean) / std;
    const score = 100 * Math.max(0, Math.min(1, (z - 2) / 4));
    metrics[metric] = { value, count, mean, std, z, points: score, available: true, reason: null };
    points.push(score);
  }
  return {
    score: points.length ? Math.round(Math.max(...points)) : null,
    reasons: points.length
      ? RISK_METRICS.filter((metric) => (metrics[metric].points ?? 0) > 0).map((metric) => `high_${metric}`)
      : ["no_available_metrics"],
    metrics,
  };
}

/** All 6 targets in one lookup; eligibility and failure reasons stay in JS. */
async function arenaRiskTargets(backend: Backend, aid: number): Promise<Map<string, Row>> {
  const modes = ["overall", ...ARENA_MODE_KEYS];
  const placeholders = modes.map(() => "?").join(", ");
  const rows = await all(
    backend,
    `SELECT ${ARENA_RISK_PROJECTION} FROM arena_mode_stats WHERE aid = ? AND arena_mode IN (${placeholders})
      AND NOT EXISTS (SELECT 1 FROM excluded_players tombstone WHERE tombstone.aid = arena_mode_stats.aid)`,
    [aid, ...modes],
  );
  return new Map(rows.map((row) => [String(row.arena_mode), row]));
}

async function arenaRiskPopulation(
  backend: Backend,
  aid: number,
  modes: ArenaStoredMode[],
): Promise<Map<string, RiskSamples>> {
  if (modes.length === 0) return new Map();
  const placeholders = modes.map(() => "?").join(", ");
  const anchorColumns = RISK_METRICS.map((metric) =>
    `MIN(CASE WHEN typeof(${metric}) IN ('integer', 'real') THEN ${metric} END) AS ${metric}_anchor`
  ).join(", ");
  const meanColumns = RISK_METRICS.map((metric) =>
    `anchors.${metric}_anchor + AVG(CASE WHEN typeof(eligible.${metric}) IN ('integer', 'real')
      THEN eligible.${metric} - anchors.${metric}_anchor END) AS ${metric}_mean`
  ).join(", ");
  const aggregateColumns = RISK_METRICS.flatMap((metric) => [
    `COUNT(CASE WHEN typeof(eligible.${metric}) IN ('integer', 'real') THEN 1 END) AS ${metric}_count`,
    `means.${metric}_mean`,
    `AVG(CASE WHEN typeof(eligible.${metric}) IN ('integer', 'real')
      THEN (eligible.${metric} - means.${metric}_mean) * (eligible.${metric} - means.${metric}_mean) END) AS ${metric}_variance`,
  ]).join(", ");
  const rows = await all(backend,
    `WITH eligible AS (
       SELECT arena_mode, ${RISK_METRICS.join(", ")}
       FROM arena_mode_stats
       WHERE arena_mode IN (${placeholders})
         AND NOT EXISTS (SELECT 1 FROM excluded_players tombstone WHERE tombstone.aid = arena_mode_stats.aid)
         AND aid != ? AND games_count >= 10 AND parser_version = ?
     ), anchors AS (
       SELECT arena_mode, ${anchorColumns} FROM eligible GROUP BY arena_mode
     ), means AS (
       SELECT eligible.arena_mode, ${meanColumns}
       FROM eligible JOIN anchors ON anchors.arena_mode = eligible.arena_mode
       GROUP BY eligible.arena_mode
     )
     SELECT eligible.arena_mode, COUNT(*) AS sample_n, ${aggregateColumns}
     FROM eligible JOIN means ON means.arena_mode = eligible.arena_mode
     GROUP BY eligible.arena_mode`, [...modes, aid, ARENA_PARSER_VERSION]);
  return new Map(rows.map((row) => {
    const metrics = new Map<ArenaMetricKey, RiskMetricStats>();
    for (const metric of RISK_METRICS) {
      const count = Number(row[`${metric}_count`]) || 0;
      const mean = numberOrNull(row[`${metric}_mean`]);
      const variance = numberOrNull(row[`${metric}_variance`]);
      metrics.set(metric, {
        count,
        mean,
        std: variance === null ? null : variance === 0 ? 0 : Math.sqrt(variance),
      });
    }
    return [String(row.arena_mode), { sampleN: Number(row.sample_n) || 0, percent: 30 as const, metrics }];
  }));
}

async function arenaRiskSamples(backend: Backend, aid: number, targets: Map<string, Row>): Promise<Map<string, RiskSamples>> {
  const countQueries: ReturnType<typeof arenaRangeCountQuery>[] = [];
  for (const mode of ARENA_MODE_KEYS) {
    const target = targets.get(mode);
    const hours = numberOrNull(target?.hours);
    const matches = numberOrNull(target?.games_count);
    if (!target || numberOrNull(target.parser_version) !== ARENA_PARSER_VERSION ||
        matches === null || matches < 10 || hours === null) continue;
    countQueries.push(arenaRangeCountQuery(aid, mode, hours, matches));
  }
  const countRows: Row[] = [];
  const batchSize = backend.kind === "d1" ? 4 : ARENA_MODE_KEYS.length;
  for (let start = 0; start < countQueries.length; start += batchSize) {
    const batch = countQueries.slice(start, start + batchSize);
    countRows.push(...await all(backend, batch.map((query) => query.sql).join(" UNION ALL "),
      batch.flatMap((query) => query.params)));
  }
  const ranges = new Map(countRows.map((row) => [String(row.arena_mode), arenaSelectedRange(row, 30)]));
  const populationModes: ArenaStoredMode[] = [];
  const matchedRanges = new Map<string, { percent: 10 | 15 | 20 | 30 }>();
  const selects: string[] = [];
  const params: unknown[] = [];
  for (const mode of ["overall", ...ARENA_MODE_KEYS] as const) {
    const target = targets.get(mode);
    if (!target || numberOrNull(target.parser_version) !== ARENA_PARSER_VERSION ||
        (numberOrNull(target.games_count) ?? 0) < 10) continue;
    const range = mode === "overall" ? undefined : ranges.get(mode);
    const hours = numberOrNull(target.hours);
    const matches = numberOrNull(target.games_count);
    if (mode === "overall" || !range || range.sampleN < 30 || hours === null || matches === null) {
      populationModes.push(mode);
      continue;
    }
    const hourBounds = proportionalBounds(hours, range.percent);
    const matchBounds = proportionalBounds(matches, range.percent);
    const condition = arenaWhere({
      mode, exceptAid: aid, eligible: true,
      minHours: hourBounds.min, maxHours: hourBounds.max,
      minMatches: matchBounds.min, maxMatches: matchBounds.max,
    });
    matchedRanges.set(mode, { percent: range.percent });
    selects.push(`SELECT arena_mode, ${RISK_METRICS.join(", ")} FROM arena_mode_stats ${condition.where}`);
    params.push(...condition.params);
  }
  const result = await arenaRiskPopulation(backend, aid, populationModes);
  if (selects.length) {
    const groups = await arenaMetricSamples(backend, selects.join(" UNION ALL "), params, RISK_METRICS);
    for (const [mode, range] of matchedRanges) {
      const group = groups.get(mode);
      result.set(mode, {
        sampleN: group?.sampleN ?? 0,
        percent: range.percent,
        metrics: riskStatsFromSamples(group),
      });
    }
  }
  return result;
}

function riskModeFromSummary(mode: ArenaModeKey, target: Row | undefined, summary: RiskSamples | undefined): ArenaModeRisk {
  const targetMatches = numberOrNull(target?.games_count);
  if (!target || numberOrNull(target.parser_version) !== ARENA_PARSER_VERSION || targetMatches === null) {
    return riskModeUnavailable(mode, "target_unavailable");
  }
  if (targetMatches < 10) return riskModeUnavailable(mode, "target_below_minimum_matches");
  const peerCount = summary?.sampleN ?? 0;
  if (peerCount < 30) return riskModeUnavailable(mode, "insufficient_peers", peerCount, summary?.percent);
  const result = riskMetrics(target, summary);
  return {
    mode,
    score: result.score,
    peerCount,
    percent: summary!.percent,
    reasons: result.reasons,
    metrics: result.metrics,
  };
}

function riskOverallFromSummary(target: Row, summary: RiskSamples | undefined): ArenaOverallRisk {
  const matches = numberOrNull(target.games_count);
  if (matches === null || matches < 10) {
    return riskOverallUnavailable("target_below_minimum_matches");
  }
  return { mode: "overall", peerCount: summary?.sampleN ?? 0, ...riskMetrics(target, summary) };
}

/** Display-only Arena anomaly score. It never calls generic moderation storage. */
export async function getStoredArenaProfileRisk(aid: number): Promise<ArenaProfileRisk | null> {
  if (!Number.isSafeInteger(aid) || aid <= 0) throw new Error("invalid arena account id");
  const backend = await getArenaBackend();
  if (!backend) return null;
  try {
    const rows = await all(backend, "SELECT risk_json FROM arena_risk_evaluations WHERE aid = ?", [aid]);
    const raw = rows[0]?.risk_json;
    if (typeof raw !== "string" || !raw) return null;
    const parsed = JSON.parse(raw) as ArenaProfileRisk;
    if (!parsed || typeof parsed !== "object" || Number(parsed.aid) !== aid) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** A stored risk is fresh when it matches the current snapshot versions and TTL. */
export function isArenaProfileRiskFresh(
  risk: ArenaProfileRisk | null,
  profileUpdatedAt: number | null,
  now = Date.now(),
): boolean {
  if (!risk) return false;
  if (risk.version?.calculation !== ARENA_RISK_CALCULATION_VERSION) return false;
  if (risk.version?.parser !== ARENA_PARSER_VERSION) return false;
  if (typeof profileUpdatedAt === "number" && Number.isFinite(profileUpdatedAt)) {
    const riskUpstream = risk.version?.upstream ?? risk.freshness?.profileUpdatedAt;
    if (riskUpstream == null || riskUpstream < profileUpdatedAt) return false;
  }
  const evaluatedAt = risk.freshness?.evaluatedAt;
  if (!Number.isFinite(evaluatedAt)) return false;
  return now - (evaluatedAt as number) < ARENA_RISK_TTL_MS;
}

const arenaRiskInFlight = new Map<number, Promise<ArenaProfileRisk | null>>();

/**
 * Coalesces concurrent Arena risk recomputations by aid. N parallel
 * stale-hits share a single flight; the entry is removed on settle so a
 * later refresh recomputes. Errors propagate to callers (the route logs).
 */
export function coalesceArenaRiskRefresh(
  aid: number,
  load: () => Promise<ArenaProfileRisk | null>,
): Promise<ArenaProfileRisk | null> {
  return singleFlight(arenaRiskInFlight, aid, load);
}

async function computeArenaProfileRisk(aid: number): Promise<ArenaProfileRisk | null> {
  const backend = await getArenaBackend();
  if (!backend) return null;
  const targets = await arenaRiskTargets(backend, aid);
  const overall = targets.get("overall");
  if (!overall || numberOrNull(overall.parser_version) !== ARENA_PARSER_VERSION) return null;
  const summaries = await arenaRiskSamples(backend, aid, targets);
  const overallRisk = riskOverallFromSummary(overall, summaries.get("overall"));
  const modes = ARENA_MODE_KEYS.map((mode) =>
    riskModeFromSummary(mode, targets.get(mode), summaries.get(mode)));
  const score = overallRisk.score;
  const risk: ArenaProfileRisk = {
    aid,
    score,
    tier: score === null ? null : riskTier(score),
    overall: overallRisk,
    modes,
    freshness: {
      fetchedAt: numberOrNull(overall.fetched_at),
      profileUpdatedAt: numberOrNull(overall.upstream_version),
      evaluatedAt: Date.now(),
    },
    version: {
      upstream: numberOrNull(overall.upstream_version),
      parser: numberOrNull(overall.parser_version),
      calculation: ARENA_RISK_CALCULATION_VERSION,
    },
  };
  await run(backend, ARENA_RISK_UPSERT_SQL, arenaRiskValues(risk, risk.freshness.evaluatedAt)).catch(() => undefined);
  return risk;
}

/** Display-only Arena anomaly score. It never calls generic moderation storage. */
export async function getArenaProfileRisk(aid: number): Promise<ArenaProfileRisk | null> {
  if (!Number.isSafeInteger(aid) || aid <= 0) throw new Error("invalid arena account id");
  return coalesceArenaRiskRefresh(aid, () => computeArenaProfileRisk(aid));
}
