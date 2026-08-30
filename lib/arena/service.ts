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

export { ARENA_PARSER_VERSION } from "@/lib/arena/storage";

type Backend = NonNullable<Awaited<ReturnType<typeof getArenaBackend>>>;
type Row = Record<string, unknown>;

const COHORT_PERCENTS = [10, 15, 20, 30] as const;
const RISK_METRICS = ["kd_ratio", "win_rate", "kills_per_match", "damage_per_match"] as const;
export const ARENA_RISK_CALCULATION_VERSION = 2;

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
    kills_per_match, damage_per_match, upstream_version, parser_version, fetched_at,
    arena_wins, arena_losses, kills, deaths, assists, headshots, damage_dealt,
    round_mvp_count, match_mvp_count, current_kill_streak, max_kill_streak,
    current_win_streak, max_win_streak, current_loss_streak, max_loss_streak, raw_json
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
  return {
    filterIdentity,
    sampleN: rows.length,
    total: rows.length,
    coverage: Object.fromEntries(ARENA_METRIC_KEYS.map((metric) => [
      metric, rows.length ? metrics[metric].count / rows.length : 0,
    ])) as Record<ArenaMetricKey, number>,
    bounds: { hours: bounds(rows, "hours"), matches: bounds(rows, "games_count") },
    metrics,
    buckets: averageBuckets(rows, filterIdentity.dimension, filterIdentity.statistic),
    population,
  };
}

function proportionalBounds(center: number, percent: 10 | 15 | 20 | 30): ArenaRangeBounds {
  const ratio = percent / 100;
  return { min: Math.max(0, center * (1 - ratio)), max: center * (1 + ratio) };
}

function emptyCohort(aid: number, mode: ArenaStoredMode, statistic: ArenaStatistic): ArenaCohortResult {
  const common = {
    aid, statistic, target: { hours: null, matches: null }, percent: 30 as const,
    sampleN: 0, required: 20, quality: "unavailable" as const, reason: "target_unavailable" as const, metrics: emptyMetrics(),
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
    const rows = await arenaRows(backend, { mode: "overall", exceptAid: aid, eligible: true });
    return {
      aid,
      mode: "overall",
      strategy: "population",
      statistic: statisticKind,
      target: { hours: targetHours, matches: targetMatches },
      percent: 30,
      bounds: { hours: { min: null, max: null }, matches: { min: 10, max: null } },
      sampleN: rows.length,
      required: 20,
      quality: rows.length >= 20 ? "sufficient" : "unavailable",
      reason: rows.length >= 20 ? null : "insufficient_cohort",
      metrics: metricSummary(rows, statisticKind, 20),
    };
  }
  if (targetHours === null || targetMatches === null) return emptyCohort(aid, arenaMode, statisticKind);
  const maxHours = proportionalBounds(targetHours, 30);
  const maxMatches = proportionalBounds(targetMatches, 30);
  const candidates = await arenaRows(backend, {
    mode: arenaMode, exceptAid: aid, eligible: true,
    minHours: maxHours.min, maxHours: maxHours.max,
    minMatches: maxMatches.min, maxMatches: maxMatches.max,
  });
  const selected = COHORT_PERCENTS.map((percent) => {
    const hours = proportionalBounds(targetHours, percent);
    const matches = proportionalBounds(targetMatches, percent);
    const rows = candidates.filter((row) => {
      const hoursValue = numberOrNull(row.hours);
      const matchesValue = numberOrNull(row.games_count);
      return hoursValue !== null && matchesValue !== null &&
        hoursValue >= hours.min! && hoursValue <= hours.max! &&
        matchesValue >= matches.min! && matchesValue <= matches.max!;
    });
    return { percent, hours, matches, rows };
  }).find((candidate) => candidate.rows.length >= 20);
  if (!selected) {
    return {
      ...emptyCohort(aid, arenaMode, statisticKind),
      target: { hours: targetHours, matches: targetMatches },
      bounds: { hours: maxHours, matches: maxMatches },
      sampleN: candidates.length,
      reason: "insufficient_cohort",
    };
  }
  return {
    aid,
    mode: arenaMode,
    strategy: "matched",
    statistic: statisticKind,
    target: { hours: targetHours, matches: targetMatches },
    percent: selected.percent,
    bounds: { hours: selected.hours, matches: selected.matches },
    sampleN: selected.rows.length,
    required: 20,
    quality: "sufficient",
    reason: null,
    metrics: metricSummary(selected.rows, statisticKind, 20),
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

function riskModeUnavailable(mode: ArenaModeKey, reason: string, peerCount = 0): ArenaModeRisk {
  return {
    mode, score: null, peerCount, percent: 30, reasons: [reason],
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

function riskMetrics(target: Row, rows: Row[]): Pick<ArenaModeRisk, "score" | "reasons" | "metrics"> {
  const metrics = {} as ArenaModeRisk["metrics"];
  const points: number[] = [];
  for (const metric of RISK_METRICS) {
    const value = numberOrNull(target[metric]);
    const values = metricValues(rows, metric);
    if (value === null) {
      metrics[metric] = { ...emptyRiskMetric("missing_metric"), count: values.length };
      continue;
    }
    if (values.length < 30) {
      metrics[metric] = { ...emptyRiskMetric("insufficient_peers"), value, count: values.length };
      continue;
    }
    const mean = values.reduce((sum, entry) => sum + entry, 0) / values.length;
    const identical = values.every((entry) => entry === values[0]);
    const variance = identical ? 0 : values.reduce((sum, entry) => sum + (entry - mean) ** 2, 0) / values.length;
    const std = Math.sqrt(variance);
    if (identical || std === 0) {
      metrics[metric] = { value, count: values.length, mean, std, z: null, points: null, available: false, reason: "zero_std" };
      continue;
    }
    const z = (value - mean) / std;
    const score = 100 * Math.max(0, Math.min(1, (z - 2) / 4));
    metrics[metric] = { value, count: values.length, mean, std, z, points: score, available: true, reason: null };
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

async function riskForMode(backend: Backend, aid: number, mode: ArenaModeKey): Promise<ArenaModeRisk> {
  const target = (await arenaRows(backend, { mode, aid }))[0];
  const targetHours = numberOrNull(target?.hours);
  const targetMatches = numberOrNull(target?.games_count);
  if (!target || numberOrNull(target.parser_version) !== ARENA_PARSER_VERSION ||
      targetHours === null || targetMatches === null) return riskModeUnavailable(mode, "target_unavailable");
  if (targetMatches < 10) return riskModeUnavailable(mode, "target_below_minimum_matches");
  const maxHours = proportionalBounds(targetHours, 30);
  const maxMatches = proportionalBounds(targetMatches, 30);
  const candidates = await arenaRows(backend, {
    mode, exceptAid: aid, eligible: true,
    minHours: maxHours.min, maxHours: maxHours.max,
    minMatches: maxMatches.min, maxMatches: maxMatches.max,
  });
  const selected = COHORT_PERCENTS.map((percent) => {
    const hours = proportionalBounds(targetHours, percent);
    const matches = proportionalBounds(targetMatches, percent);
    return {
      percent,
      rows: candidates.filter((row) => {
        const h = numberOrNull(row.hours);
        const m = numberOrNull(row.games_count);
        return h !== null && m !== null && h >= hours.min! && h <= hours.max! && m >= matches.min! && m <= matches.max!;
      }),
    };
  }).find((candidate) => candidate.rows.length >= 30);
  if (!selected) return riskModeUnavailable(mode, "insufficient_peers", candidates.length);
  const result = riskMetrics(target, selected.rows);
  return {
    mode,
    score: result.score,
    peerCount: selected.rows.length,
    percent: selected.percent,
    reasons: result.reasons,
    metrics: result.metrics,
  };
}

async function riskForOverall(backend: Backend, aid: number, target: Row): Promise<ArenaOverallRisk> {
  const matches = numberOrNull(target.games_count);
  if (matches === null || matches < 10) {
    return riskOverallUnavailable("target_below_minimum_matches");
  }
  const rows = await arenaRows(backend, { mode: "overall", exceptAid: aid, eligible: true });
  return { mode: "overall", peerCount: rows.length, ...riskMetrics(target, rows) };
}

/** Display-only Arena anomaly score. It never calls generic moderation storage. */
export async function getArenaProfileRisk(aid: number): Promise<ArenaProfileRisk | null> {
  if (!Number.isSafeInteger(aid) || aid <= 0) throw new Error("invalid arena account id");
  const backend = await getArenaBackend();
  if (!backend) return null;
  const targetRows = await arenaRows(backend, { mode: "overall", aid });
  const overall = targetRows[0];
  if (!overall || numberOrNull(overall.parser_version) !== ARENA_PARSER_VERSION) return null;
  const [overallRisk, modes] = await Promise.all([
    riskForOverall(backend, aid, overall),
    Promise.all(ARENA_MODE_KEYS.map((mode) => riskForMode(backend, aid, mode))),
  ]);
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
