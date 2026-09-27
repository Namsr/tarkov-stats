/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-ignore Node's strip-types test runner requires the explicit extension.
import { loadSeasonalCycleConfig } from "./config.ts";
// @ts-ignore Node's strip-types test runner requires the explicit extension.
import { buildSeasonalAverageSeries, LIFETIME_BAND_DISTRIBUTION_SQL, lifetimeBandDistribution, progressionDailySql, SEASONAL_POPULATION_SQL, seasonalPopulationArgs, seasonalPopulationSummary, type DailyRow, type LifetimeBandCountRow, type SeasonalPopulationRow } from "./progression.ts";
// @ts-ignore Node's strip-types test runner requires the explicit extension.
import { initializeSeasonalSchema, parseSeasonalAchievementUnlocks, upsertSqliteSeasonCycle } from "./storage.ts";
// @ts-ignore Node's strip-types test runner requires the explicit extension.
import type { ProgressionKind, SeasonalAverageResponse } from "../../types/seasonal.ts";
import type { AveragePeriod, AverageStatistic } from "../db";
// @ts-ignore Node's strip-types test runner requires the explicit extension.
import { resolveY } from "../metrics.ts";
// @ts-ignore Node's strip-types test runner requires the explicit extension.
import type { AverageDashboardResponse } from "../../types/average.ts";
// @ts-ignore Node's strip-types test runner requires the explicit extension.
// @ts-ignore Node's strip-types test runner requires the explicit extension.
import { achievementUnlockHours } from "../achievement-unlock-hours.ts";

export type SeasonalAverageDimension = "hours" | "pmc_raids";

export interface SeasonalAverageCrossSectionResponse extends AverageDashboardResponse {
  mode: "seasonal";
  cycleId: string;
  period: AveragePeriod;
  statistic: AverageStatistic;
  total: number;
  averages: AverageDashboardResponse["averages"];
  metricCounts: Record<string, number>;
  buckets: AverageDashboardResponse["buckets"];
  bounds: AverageDashboardResponse["bounds"];
  dimension: SeasonalAverageDimension;
  metric: string;
}

const SEASONAL_AVG_COLS = [
  "hours", "total_raids", "pmc_raids", "scav_raids", "survival_rate",
  "kd_ratio", "pmc_kd_ratio", "kills_per_raid", "total_kills", "deaths",
  "killed_pmc", "run_through", "longest_win_streak", "achv_count", "level", "prestige",
  "pmc_survival_rate",
] as const;

const DEFAULT_BOUNDS = { hours: { min: 0, max: 5000 }, pmc_raids: { min: 0, max: 1000 } } as const;
const TRIM_FRACTION = 0.05;
const MIN_TRIM_N = 20;

/** Latest Seasonal snapshot plus the account-wide PvP hours enrichment. */
const PORTRAIT_CTE = `
WITH latest AS (
  SELECT s.* FROM progression_snapshots s
  JOIN (
    SELECT aid, cycle_id, MAX(profile_updated_at) AS profile_updated_at
    FROM progression_snapshots
    WHERE mode = 'seasonal' AND cycle_id = ?
    GROUP BY aid, cycle_id
  ) current ON current.aid = s.aid AND current.cycle_id = s.cycle_id
    AND current.profile_updated_at = s.profile_updated_at
  WHERE s.mode = 'seasonal' AND s.cycle_id = ?
), portrait AS (
  SELECT p.aid, p.profile_updated_at,
    p.lifetime_pvp_hours AS hours,
    latest.total_raids AS total_raids,
    latest.pmc_raids AS pmc_raids,
    latest.scav_raids AS scav_raids,
    latest.survived AS survived,
    latest.deaths AS deaths,
    latest.total_kills AS total_kills,
    latest.killed_pmc AS killed_pmc,
    latest.run_through AS run_through,
    latest.longest_win_streak AS longest_win_streak,
    latest.level AS level,
    latest.prestige AS prestige,
    CASE WHEN latest.achievements IS NOT NULL AND json_valid(latest.achievements)
      THEN COALESCE(latest.achv_count, json_array_length(latest.achievements)) ELSE NULL END AS achv_count,
    latest.pmc_survived AS pmc_survived,
    latest.pmc_deaths AS pmc_deaths,
    latest.pmc_kills AS pmc_kills
  FROM player_profiles p
  JOIN latest ON latest.aid = p.aid
    AND latest.mode = p.mode AND latest.cycle_id = p.cycle_id
  WHERE p.mode = 'seasonal' AND p.cycle_id = ? AND p.confirmed_banned = 0
    AND NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = p.aid)
    AND (p.pmc_raids >= 1 OR p.scav_raids >= 1)
), normalized AS (
  SELECT portrait.*,
    CASE WHEN total_raids > 0 THEN 100.0 * survived / total_raids END AS survival_rate,
    CASE WHEN deaths IS NULL OR total_kills IS NULL THEN NULL
      WHEN deaths > 0 THEN 1.0 * total_kills / deaths ELSE total_kills END AS kd_ratio,
    CASE WHEN pmc_deaths > 0 THEN 1.0 * killed_pmc / pmc_deaths ELSE killed_pmc END AS pmc_kd_ratio,
    CASE WHEN total_raids > 0 THEN 1.0 * total_kills / total_raids END AS kills_per_raid,
    CASE WHEN pmc_raids > 0 THEN 100.0 * pmc_survived / pmc_raids END AS pmc_survival_rate
  FROM portrait
)
`;

function trimWindow(n: number) {
  const off = n >= MIN_TRIM_N ? Math.floor(n * TRIM_FRACTION) : 0;
  return { off, limit: n - off * 2 };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AverageBackend = { db: any };

async function backendRows(backend: AverageBackend, sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  return backend.db.prepare(sql).all(...params) as Record<string, unknown>[];
}

async function backendFirst(backend: AverageBackend, sql: string, params: unknown[]): Promise<Record<string, unknown> | null> {
  return backend.db.prepare(sql).get(...params) as Record<string, unknown> | null;
}

function seasonalBucket(dimension: SeasonalAverageDimension, value: number): { lo: number; hi: number | null } {
  if (dimension === "hours") return seasonalHoursBucket(value);
  if (value >= 3000) return { lo: 3000, hi: null };
  if (value < 1000) {
    const lo = Math.trunc(value / 25) * 25;
    return { lo, hi: lo + 25 };
  }
  const lo = 1000 + Math.trunc((value - 1000) / 50) * 50;
  return { lo, hi: lo + 50 };
}

export interface SeasonalPublicationVariantTimings {
  variant: string;
  period: AveragePeriod;
  statistic: AverageStatistic;
  computeMs: number;
}

export interface SeasonalPublicationTimings {
  /** The single shared portrait scan; previously re-evaluated ~38x per variant. */
  portraitFetchMs: number;
  portraitRows: number;
  totalMs: number;
  variants: SeasonalPublicationVariantTimings[];
}

const SEASONAL_PORTRAIT_COLUMNS = [
  "aid", "profile_updated_at", "hours", "total_raids", "pmc_raids", "scav_raids",
  "survived", "deaths", "total_kills", "killed_pmc", "run_through", "longest_win_streak",
  "level", "prestige", "achv_count", "pmc_survived", "pmc_deaths", "pmc_kills",
  "survival_rate", "kd_ratio", "pmc_kd_ratio", "kills_per_raid", "pmc_survival_rate",
] as const;

const SEASONAL_PUBLICATION_STATISTICS = ["trimmed_mean", "median"] as const satisfies readonly AverageStatistic[];
const SEASONAL_PUBLICATION_PERIODS = ["all", "90d"] as const satisfies readonly AveragePeriod[];

function standardSeasonalVariant(statistic: AverageStatistic, period: AveragePeriod): string {
  return `standard:${statistic}:${period}`;
}

async function openSeasonalAverageBackend(): Promise<AverageBackend | null> {
  try {
    if (!database) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sqlite = (await import("node:sqlite" as string)) as any;
      database = new sqlite.DatabaseSync(
        process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db",
      );
      initializeSeasonalSchema(database);
    }
    return { db: database };
  } catch (error) {
    console.warn("seasonal average backend unavailable: " + (error as Error).message);
    return null;
  }
}

function finiteOrNull(value: unknown): number | null {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function averageNumbers(values: number[], statistic: AverageStatistic): number | null {
  if (values.length === 0) return null;
  if (statistic === "median") {
    const sorted = [...values].sort((left, right) => left - right);
    const n = sorted.length;
    if (n % 2 === 1) return sorted[(n - 1) / 2] ?? null;
    return ((sorted[n / 2 - 1] ?? 0) + (sorted[n / 2] ?? 0)) / 2;
  }
  const { off, limit } = trimWindow(values.length);
  if (off === 0) return values.reduce((sum, value) => sum + value, 0) / values.length;
  const sorted = [...values].sort((left, right) => left - right);
  const window = sorted.slice(off, off + limit);
  if (window.length === 0) return null;
  return window.reduce((sum, value) => sum + value, 0) / window.length;
}

/** Mirrors the hours branch of bucketExpressions; Math.trunc matches SQLite CAST AS INTEGER. */
export function seasonalHoursBucket(value: number): { lo: number; hi: number | null } {
  if (value >= 10000) return { lo: 10000, hi: null };
  if (value < 2000) {
    const lo = Math.trunc(value / 50) * 50;
    return { lo, hi: lo + 50 };
  }
  const lo = 2000 + Math.trunc((value - 2000) / 100) * 100;
  return { lo, hi: lo + 100 };
}

/**
 * Pure builder used by the publication batch path. It replicates the
 * per-variant SQL semantics (period-only total/buckets/bounds, period+range
 * averages) over an already-fetched portrait snapshot.
 */
export function buildSeasonalCrossSectionFromRows(
  rows: readonly Record<string, unknown>[],
  input: {
    cycleId: string;
    period: AveragePeriod;
    statistic: AverageStatistic;
    dimension: SeasonalAverageDimension;
    metric: string;
    min: number | null;
    max: number | null;
    now?: number;
  },
): SeasonalAverageCrossSectionResponse {
  const now = input.now ?? Date.now();
  const metric = resolveY(input.metric).key;
  const dimensionColumn = input.dimension === "hours" ? "hours" : "pmc_raids";
  const cutoff = input.period === "90d" ? Math.floor(now - 90 * 86_400_000) : null;
  const periodRows = cutoff == null
    ? [...rows]
    : rows.filter((row) => Number(row.profile_updated_at) >= cutoff);
  const inRange = (row: Record<string, unknown>) => {
    const value = finiteOrNull(row[dimensionColumn]);
    if (value == null) return input.min == null && input.max == null ? true : false;
    if (input.min != null && value < input.min) return false;
    if (input.max != null && value > input.max) return false;
    return true;
  };
  const scopedRows = periodRows.filter(inRange);
  const total = periodRows.length;
  const averages = { n: scopedRows.length } as NonNullable<AverageDashboardResponse["averages"]>;
  const metricCounts: Record<string, number> = {};
  for (const column of SEASONAL_AVG_COLS) {
    const values: number[] = [];
    for (const row of scopedRows) {
      const value = finiteOrNull(row[column]);
      if (value != null) values.push(value);
    }
    metricCounts[column] = values.length;
    averages[column] = averageNumbers(values, input.statistic);
  }
  // Buckets ignore the requested range: the histogram spans the whole period so
  // the page can draw the full domain and highlight the selected slice. A row
  // whose range metric is null is excluded from its bucket entirely, which is
  // what the SQL counted, and for a median bucket the sum carries
  // median * n so the client still recovers median from sum / n.
  const metricDef = resolveY(metric);
  const rangeColumn = metricDef.agg === "count" ? null : (metricDef.column ?? metric);
  const medianBucket = input.statistic === "median" && rangeColumn != null;
  const grouped = new Map<string, { lo: number; hi: number | null; n: number; values: number[] }>();
  let boundLo: number | null = null;
  let boundHi: number | null = null;
  for (const row of periodRows) {
    const value = finiteOrNull(row[dimensionColumn]);
    if (value == null) continue;
    if (boundLo == null || value < boundLo) boundLo = value;
    if (boundHi == null || value > boundHi) boundHi = value;
    const metricValue = rangeColumn == null ? null : finiteOrNull(row[rangeColumn]);
    if (rangeColumn != null && metricValue == null) continue;
    const bucket = seasonalBucket(input.dimension, value);
    const key = `${bucket.lo}:${bucket.hi ?? ""}`;
    const entry = grouped.get(key) ?? { lo: bucket.lo, hi: bucket.hi, n: 0, values: [] as number[] };
    entry.n += 1;
    if (metricValue != null) entry.values.push(metricValue);
    grouped.set(key, entry);
  }
  const buckets = [...grouped.values()]
    .sort((left, right) => left.lo - right.lo)
    .map((entry) => ({
      lo: entry.lo,
      hi: entry.hi,
      n: entry.n,
      sum: medianBucket
        ? (averageNumbers(entry.values, "median") ?? 0) * entry.n
        : entry.values.reduce((total, value) => total + value, 0),
    }));
  return {
    mode: "seasonal",
    cycleId: input.cycleId,
    period: input.period,
    statistic: input.statistic,
    total,
    averages: total === 0 ? null : averages,
    metricCounts,
    buckets,
    bounds: boundLo == null || boundHi == null
      ? DEFAULT_BOUNDS[input.dimension]
      : { min: Math.max(0, Math.floor(boundLo)), max: Math.ceil(boundHi) },
    dimension: input.dimension,
    metric,
  };
}

/**
 * Batch path for the publication materializer. The legacy per-variant query
 * re-evaluated PORTRAIT_CTE ~38 times per variant (152 scans for the full
 * 2 statistics x 2 periods matrix), which dominated the ~9 minute production
 * build. This fetches the normalized portrait once and derives all four
 * standard variants in JS, keeping the single transactional publish so a
 * parallel/incremental build can never expose a partial set.
 */
export async function getSeasonalAveragePublicationPayloads(
  cycleId: string,
  now: number = Date.now(),
): Promise<{
    payloads: Map<string, SeasonalAverageCrossSectionResponse>;
    timings: SeasonalPublicationTimings;
  } | null> {
  const totalStartedAt = Date.now();
  const backend = await openSeasonalAverageBackend();
  if (!backend) return null;
  let rows: Record<string, unknown>[];
  const portraitFetchStartedAt = Date.now();
  try {
    rows = await backendRows(backend,
      `${PORTRAIT_CTE} SELECT ${SEASONAL_PORTRAIT_COLUMNS.join(", ")} FROM normalized`,
      [cycleId, cycleId, cycleId],
    );
  } catch (error) {
    console.warn("seasonal publication portrait fetch failed: " + (error as Error).message);
    return null;
  }
  const portraitFetchMs = Date.now() - portraitFetchStartedAt;
  const payloads = new Map<string, SeasonalAverageCrossSectionResponse>();
  const variants: SeasonalPublicationVariantTimings[] = [];
  for (const statistic of SEASONAL_PUBLICATION_STATISTICS) {
    for (const period of SEASONAL_PUBLICATION_PERIODS) {
      const computeStartedAt = Date.now();
      const response = buildSeasonalCrossSectionFromRows(rows, {
        cycleId, period, statistic, dimension: "hours", metric: "players", min: null, max: null, now,
      });
      const computeMs = Date.now() - computeStartedAt;
      const variant = standardSeasonalVariant(statistic, period);
      payloads.set(variant, response);
      variants.push({ variant, period, statistic, computeMs });
    }
  }
  return {
    payloads,
    timings: {
      portraitFetchMs,
      portraitRows: rows.length,
      totalMs: Date.now() - totalStartedAt,
      variants,
    },
  };
}

/** Query adapter for the Seasonal cross-section; it never opens the regular player store. */
export async function getSeasonalAverageCrossSectionQuery(): Promise<
  ((input: {
    cycleId: string;
    period: AveragePeriod;
    statistic: AverageStatistic;
    dimension: SeasonalAverageDimension;
    metric: string;
    min: number | null;
    max: number | null;
    now?: number;
  }) => Promise<SeasonalAverageCrossSectionResponse | null>) | null
> {
  try {
    const backend = await openSeasonalAverageBackend();
    if (!backend) return null;

    // One portrait scan per request, everything else in JS. The previous
    // per-request path re-evaluated PORTRAIT_CTE ~39 times (a population count, a
    // scoped count, a COUNT plus a ranked statistic for each of the 17 metric
    // columns, the bucket aggregate and the bounds), and every evaluation
    // rebuilt the portrait from the snapshot self-join and then sorted computed
    // ratios in a temp B-tree. One drag of the range slider therefore blocked the
    // event loop for tens of seconds and took the whole site down with it. This
    // is the shape the publication materializer already uses.
    return async (input) => {
      const rows = await backendRows(backend,
        `${PORTRAIT_CTE} SELECT ${SEASONAL_PORTRAIT_COLUMNS.join(", ")} FROM normalized`,
        [input.cycleId, input.cycleId, input.cycleId],
      );
      return buildSeasonalCrossSectionFromRows(rows, {
        cycleId: input.cycleId,
        period: input.period,
        statistic: input.statistic,
        dimension: input.dimension,
        metric: input.metric,
        min: input.min,
        max: input.max,
        ...(input.now === undefined ? {} : { now: input.now }),
      });
    };
  } catch (error) {
    console.warn("seasonal cross-section query unavailable: " + (error as Error).message);
    return null;
  }
}

export interface SeasonalAchievementBaselineEntry {
  ach_id: string;
  owners: number;
  eligibleN: number;
  prevalencePct: number;
  meanHours: number;
  stdHours: number;
  earlyHours: number;
  unlockHours: number;
  /** 20th percentile of unlock day from the current cycle start. */
  unlockDayP20: number | null;
  timestampOwners: number;
}

export interface SeasonalAchievementBaseline {
  /** Kept as an alias for existing risk callers; equals eligibleN. */
  total: number;
  eligibleN: number;
  seasonStartsAt: number | null;
  achievements: SeasonalAchievementBaselineEntry[];
}

function finiteValue(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

const SEASONAL_RISK_COHORT_PERCENTAGES = [10, 15, 20, 30] as const;
const SEASONAL_RISK_COHORT_TARGET = 30;
type SeasonalRiskCohortPercent = (typeof SEASONAL_RISK_COHORT_PERCENTAGES)[number];

function seasonalRiskRangeFor(
  center: { hours: number; pmcRaids: number },
  percent: SeasonalRiskCohortPercent,
) {
  const ratio = percent / 100;
  const hourEpsilon = 1e-9 * Math.max(1, Math.abs(center.hours));
  const raidEpsilon = 1e-9 * Math.max(1, Math.abs(center.pmcRaids));
  return {
    hours: {
      min: Math.max(0, Math.floor((center.hours * (1 - ratio) + hourEpsilon) * 10) / 10),
      max: Math.ceil((center.hours * (1 + ratio) - hourEpsilon) * 10) / 10,
    },
    pmcRaids: {
      min: Math.max(0, Math.floor(center.pmcRaids * (1 - ratio) + raidEpsilon)),
      max: Math.ceil(center.pmcRaids * (1 + ratio) - raidEpsilon),
    },
  };
}

function finiteRiskCount(value: unknown): number {
  const count = finiteValue(value);
  return count != null && count >= 0 ? count : 0;
}

export function selectSeasonalRiskPercent(
  counts: Readonly<Record<SeasonalRiskCohortPercent, number>>,
): SeasonalRiskCohortPercent {
  return SEASONAL_RISK_COHORT_PERCENTAGES.find((percent) =>
    finiteRiskCount(counts[percent]) >= SEASONAL_RISK_COHORT_TARGET
  ) ?? 30;
}

function percentile20(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.floor((sorted.length - 1) * 0.2))] ?? null;
}

function summary(values: number[]): { mean: number; std: number; early: number } {
  if (values.length === 0) return { mean: 0, std: 0, early: 0 };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return {
    mean,
    std: Math.sqrt(Math.max(0, variance)),
    early: percentile20(values) ?? mean,
  };
}

export async function getSeasonalAchievementBaseline(
  cycleId: string,
  excludeAid?: number,
): Promise<SeasonalAchievementBaseline | null> {
  try {
    const backend = await openSeasonalAverageBackend();
    if (!backend) return null;
    const cycle = await backendFirst(
      backend,
      "SELECT starts_at FROM season_cycles WHERE mode = 'seasonal' AND cycle_id = ?",
      [cycleId],
    );
    const seasonStartsAt = finiteValue(cycle?.starts_at);
    const rows = await backendRows(backend, `WITH latest AS (
      SELECT s.* FROM progression_snapshots s
      JOIN (
        SELECT aid, cycle_id, MAX(profile_updated_at) AS profile_updated_at
        FROM progression_snapshots
        WHERE mode = 'seasonal' AND cycle_id = ?
        GROUP BY aid, cycle_id
      ) current ON current.aid = s.aid AND current.cycle_id = s.cycle_id
        AND current.profile_updated_at = s.profile_updated_at
      WHERE s.mode = 'seasonal' AND s.cycle_id = ?
    ) SELECT p.aid, p.lifetime_pvp_hours AS hours, latest.achievements,
        cycle.starts_at
      FROM player_profiles p
      JOIN latest ON latest.aid = p.aid
        AND latest.mode = p.mode AND latest.cycle_id = p.cycle_id
      JOIN season_cycles cycle ON cycle.mode = 'seasonal' AND cycle.cycle_id = ?
      WHERE p.mode = 'seasonal' AND p.cycle_id = ? AND p.confirmed_banned = 0
        AND NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = p.aid)
        AND latest.pmc_raids >= 1
        ${excludeAid == null ? "" : "AND p.aid != ?"}
        AND latest.achievements IS NOT NULL AND json_valid(latest.achievements)`,
      [cycleId, cycleId, cycleId, cycleId, ...(excludeAid == null ? [] : [excludeAid])]);

    const eligible = rows.flatMap((row) => {
      const achievements = parseSeasonalAchievementUnlocks(row.achievements);
      if (achievements === null) return [];
      return [{
        aid: Number(row.aid),
        hours: finiteValue(row.hours),
        startsAt: finiteValue(row.starts_at),
        achievements,
      }];
    });
    const byAchievement = new Map<string, {
      hours: number[];
      unlockDays: number[];
      owners: Set<number>;
    }>();
    for (const owner of eligible) {
      const aid = owner.aid;
      for (const achievement of owner.achievements) {
        const entry = byAchievement.get(achievement.id) ?? {
          hours: [], unlockDays: [], owners: new Set<number>(),
        };
        entry.owners.add(aid);
        if (owner.hours !== null && owner.hours >= 0) entry.hours.push(owner.hours);
        if (achievement.unlockedAt !== null && owner.startsAt !== null) {
          const day = (achievement.unlockedAt - owner.startsAt) / 86_400_000;
          if (Number.isFinite(day) && day >= 0) entry.unlockDays.push(day);
        }
        byAchievement.set(achievement.id, entry);
      }
    }
    const eligibleN = eligible.length;
    return {
      total: eligibleN,
      eligibleN,
      seasonStartsAt,
      achievements: [...byAchievement.entries()].map(([ach_id, value]) => {
        const hours = summary(value.hours);
        return {
          ach_id,
          owners: value.owners.size,
          eligibleN,
          prevalencePct: eligibleN > 0 ? value.owners.size / eligibleN * 100 : 0,
          meanHours: hours.mean,
          stdHours: hours.std,
          earlyHours: hours.early,
          unlockHours: achievementUnlockHours(value.hours) ?? hours.mean,
          unlockDayP20: percentile20(value.unlockDays),
          timestampOwners: value.unlockDays.length,
        };
      }).sort((left, right) => left.prevalencePct - right.prevalencePct || left.ach_id.localeCompare(right.ach_id)),
    };
  } catch (error) {
    console.warn("seasonal achievement baseline unavailable: " + (error as Error).message);
    return null;
  }
}

export function seasonalRiskMatchesIdentity(
  risk: { aid: number; mode: string; cycleId: string } | null | undefined,
  identity: { aid: number; cycleId: string },
): risk is { aid: number; mode: string; cycleId: string } {
  return Boolean(risk && risk.aid === identity.aid && risk.mode === "seasonal" &&
    risk.cycleId === identity.cycleId);
}

export async function getSeasonalRiskBaseline(
  cycleId: string,
  center: { hours: number; pmcRaids: number },
  excludeAid: number,
) {
  if (!Number.isFinite(center.hours) || center.hours <= 0 ||
      !Number.isFinite(center.pmcRaids) || center.pmcRaids < 0) return null;
  try {
    const backend = await openSeasonalAverageBackend();
    if (!backend) return null;
    const population = `WITH latest AS (
      SELECT s.* FROM progression_snapshots s
      JOIN (
        SELECT aid, cycle_id, MAX(profile_updated_at) AS profile_updated_at
        FROM progression_snapshots
        WHERE mode = 'seasonal' AND cycle_id = ?
        GROUP BY aid, cycle_id
      ) current ON current.aid = s.aid AND current.cycle_id = s.cycle_id
        AND current.profile_updated_at = s.profile_updated_at
      WHERE s.mode = 'seasonal' AND s.cycle_id = ?
    ), eligible AS (
      SELECT p.aid, p.lifetime_pvp_hours AS hours, latest.pmc_raids,
        latest.pmc_survived, latest.pmc_deaths, latest.pmc_kills,
        latest.killed_pmc, latest.longest_win_streak, latest.prestige
      FROM player_profiles p
      JOIN latest ON latest.aid = p.aid
        AND latest.mode = p.mode AND latest.cycle_id = p.cycle_id
      WHERE p.mode = 'seasonal' AND p.cycle_id = ? AND p.confirmed_banned = 0
        AND NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = p.aid)
        AND p.lifetime_pvp_hours > 0 AND latest.pmc_raids > 0
    )`;
    const selectedRange = (percent: SeasonalRiskCohortPercent) => {
      const range = seasonalRiskRangeFor(center, percent);
      return {
        where: "WHERE aid != ? AND hours >= ? AND hours <= ? AND pmc_raids >= ? AND pmc_raids <= ?",
        params: [excludeAid, range.hours.min, range.hours.max, range.pmcRaids.min, range.pmcRaids.max],
      };
    };
    const widest = selectedRange(30);
    const countConditions = SEASONAL_RISK_COHORT_PERCENTAGES.map((percent) => {
      const range = seasonalRiskRangeFor(center, percent);
      return {
        sql: "hours >= ? AND hours <= ? AND pmc_raids >= ? AND pmc_raids <= ?",
        params: [range.hours.min, range.hours.max, range.pmcRaids.min, range.pmcRaids.max],
      };
    });
    const countRow = await backendFirst(backend,
      `${population} SELECT ${SEASONAL_RISK_COHORT_PERCENTAGES.map((percent, index) =>
        `SUM(CASE WHEN ${countConditions[index].sql} THEN 1 ELSE 0 END) AS count_${percent}`
      ).join(", ")} FROM eligible ${widest.where}`,
      [cycleId, cycleId, cycleId, ...countConditions.flatMap((condition) => condition.params), ...widest.params],
    );
    const counts = Object.fromEntries(SEASONAL_RISK_COHORT_PERCENTAGES.map((percent) => [
      percent, finiteRiskCount(countRow?.[`count_${percent}`]),
    ])) as Record<SeasonalRiskCohortPercent, number>;
    const selectedPercent = selectSeasonalRiskPercent(counts);
    const populationFallback = counts[selectedPercent] < SEASONAL_RISK_COHORT_TARGET;
    const selected = populationFallback
      ? { where: "WHERE aid != ?", params: [excludeAid] }
      : selectedRange(selectedPercent);
    const rows = await backendRows(backend,
      `${population} SELECT pmc_raids, pmc_survived, pmc_deaths,
        pmc_kills, killed_pmc, longest_win_streak, prestige
      FROM eligible ${selected.where}`,
      [cycleId, cycleId, cycleId, ...selected.params],
    );
    const metrics: Record<string, number[]> = {
      pmc_survival_rate: [], pmc_kd_ratio: [], pmc_kills_per_raid: [],
      longest_win_streak: [], prestige: [],
    };
    for (const row of rows) {
      const raids = finiteValue(row.pmc_raids);
      const survived = finiteValue(row.pmc_survived);
      const deaths = finiteValue(row.pmc_deaths);
      const killedPmc = finiteValue(row.killed_pmc);
      const kills = finiteValue(row.pmc_kills);
      if (raids == null || survived == null || deaths == null || killedPmc == null || kills == null) continue;
      metrics.pmc_survival_rate.push(survived / raids * 100);
      metrics.pmc_kd_ratio.push(deaths > 0 ? killedPmc / deaths : killedPmc);
      metrics.pmc_kills_per_raid.push(kills / raids);
      const streak = finiteValue(row.longest_win_streak);
      const prestige = finiteValue(row.prestige);
      if (streak != null) metrics.longest_win_streak.push(streak);
      if (prestige != null) metrics.prestige.push(prestige);
    }
    const meanStd = (values: number[]) => {
      if (values.length === 0) return null;
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
      return { n: values.length, mean, std: Math.sqrt(Math.max(0, variance)) };
    };
    return {
      n: rows.length,
      metrics: Object.fromEntries(Object.entries(metrics).flatMap(([key, values]) => {
        const result = meanStd(values);
        return result ? [[key, result]] : [];
      })),
    };
  } catch (error) {
    console.warn("seasonal risk baseline unavailable: " + (error as Error).message);
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let database: any = null;

const KINDS = ["cumulative", "tempo", "form"] as const satisfies readonly ProgressionKind[];

export async function getSeasonalAverageQuery(): Promise<
  ((cycleId: string, now?: number) => Promise<SeasonalAverageResponse | null>) | null
> {
  try {
    const configuredCycle = loadSeasonalCycleConfig();
    if (!database) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sqlite = (await import("node:sqlite" as string)) as any;
      database = new sqlite.DatabaseSync(
        process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db"
      );
      initializeSeasonalSchema(database);
    }
    if (configuredCycle) upsertSqliteSeasonCycle(database, configuredCycle);
    return async (cycleId, now = Date.now()) => {
      const cycle = database.prepare(
        "SELECT starts_at FROM season_cycles WHERE mode = 'seasonal' AND cycle_id = ?"
      ).get(cycleId) as { starts_at: number } | undefined;
      if (!cycle) return null;
      const population = database.prepare(SEASONAL_POPULATION_SQL)
        .get(...seasonalPopulationArgs(cycleId, now)) as SeasonalPopulationRow | undefined;
      const distribution = lifetimeBandDistribution(
        database.prepare(LIFETIME_BAND_DISTRIBUTION_SQL).all("seasonal", cycleId) as LifetimeBandCountRow[]
      );
      const series = Object.fromEntries(KINDS.map((kind) => [
        kind,
        buildSeasonalAverageSeries(
          database.prepare(progressionDailySql(kind))
            .all("seasonal", cycleId, "seasonal", cycleId, -1) as DailyRow[],
          Number(cycle.starts_at),
          kind,
          distribution,
        ),
      ])) as SeasonalAverageResponse["series"];
      return {
        mode: "seasonal",
        cycleId,
        population: seasonalPopulationSummary(population, distribution),
        series,
      };
    };
  } catch (error) {
    console.warn("seasonal average query unavailable: " + (error as Error).message);
    return null;
  }
}
