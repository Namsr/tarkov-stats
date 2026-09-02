/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-ignore Node's strip-types test runner requires the explicit extension.
import { loadSeasonalCycleConfig } from "./config.ts";
// @ts-ignore Node's strip-types test runner requires the explicit extension.
import { d1Rows, getSeasonalD1 } from "./d1.ts";
// @ts-ignore Node's strip-types test runner requires the explicit extension.
import { buildSeasonalAverageSeries, LIFETIME_BAND_DISTRIBUTION_SQL, lifetimeBandDistribution, progressionDailySql, SEASONAL_POPULATION_SQL, seasonalPopulationArgs, seasonalPopulationSummary, type DailyRow, type LifetimeBandCountRow, type SeasonalPopulationRow } from "./progression.ts";
// @ts-ignore Node's strip-types test runner requires the explicit extension.
import { initializeSeasonalSchema, parseSeasonalAchievementUnlocks, upsertSqliteSeasonCycle } from "./storage.ts";
// @ts-ignore Node's strip-types test runner requires the explicit extension.
import { upsertD1SeasonCycle } from "./storage-d1.ts";
// @ts-ignore Node's strip-types test runner requires the explicit extension.
import type { ProgressionKind, SeasonalAverageResponse } from "../../types/seasonal.ts";
import type { AveragePeriod, AverageStatistic } from "../db";
// @ts-ignore Node's strip-types test runner requires the explicit extension.
import { resolveY } from "../metrics.ts";
// @ts-ignore Node's strip-types test runner requires the explicit extension.
import type { D1DatabaseLike } from "./d1.ts";
// @ts-ignore Node's strip-types test runner requires the explicit extension.
import type { AverageDashboardResponse } from "../../types/average.ts";
// @ts-ignore Node's strip-types test runner requires the explicit extension.
import type { Baseline } from "../cheater-score.ts";
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
    CASE WHEN deaths > 0 THEN 1.0 * total_kills / deaths ELSE total_kills END AS kd_ratio,
    CASE WHEN pmc_deaths > 0 THEN 1.0 * killed_pmc / pmc_deaths ELSE killed_pmc END AS pmc_kd_ratio,
    CASE WHEN total_raids > 0 THEN 1.0 * total_kills / total_raids END AS kills_per_raid,
    CASE WHEN pmc_raids > 0 THEN 100.0 * pmc_survived / pmc_raids END AS pmc_survival_rate
  FROM portrait
)
`;

function metricExpression(metric: string): string {
  if (metric === "players") return "1";
  if (!SEASONAL_AVG_COLS.includes(metric as typeof SEASONAL_AVG_COLS[number])) {
    throw new Error(`invalid Seasonal average metric: ${metric}`);
  }
  return metric;
}

function appendRange(where: string[], params: unknown[], dimension: SeasonalAverageDimension, min: number | null, max: number | null) {
  const column = dimension === "hours" ? "hours" : "pmc_raids";
  if (min != null) { where.push(`${column} >= ?`); params.push(min); }
  if (max != null) { where.push(`${column} <= ?`); params.push(max); }
}

function readNumber(row: Record<string, unknown> | undefined, key: string): number | null {
  const value = row?.[key];
  return value == null ? null : Number(value);
}

function trimWindow(n: number) {
  const off = n >= MIN_TRIM_N ? Math.floor(n * TRIM_FRACTION) : 0;
  return { off, limit: n - off * 2 };
}

type AverageBackend = { kind: "d1" | "sqlite"; db: D1DatabaseLike };

async function backendRows(backend: AverageBackend, sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  if (backend.kind === "d1") {
    const result = await backend.db.prepare(sql).bind(...params).all();
    return d1Rows(result);
  }
  return backend.db.prepare(sql).all(...params) as Record<string, unknown>[];
}

async function backendFirst(backend: AverageBackend, sql: string, params: unknown[]): Promise<Record<string, unknown> | null> {
  if (backend.kind === "d1") {
    return await backend.db.prepare(sql).bind(...params).first() as Record<string, unknown> | null;
  }
  return backend.db.prepare(sql).get(...params) as Record<string, unknown> | null;
}

function periodWhere(period: AveragePeriod, params: unknown[], now: number): string[] {
  if (period !== "90d") return [];
  params.push(Math.floor(now - 90 * 86_400_000));
  return ["profile_updated_at >= ?"];
}

function averageSql(expression: string, where: string, statistic: AverageStatistic, count: number) {
  if (statistic === "median") {
    return `, ranked AS (
      SELECT ${expression} AS v, ROW_NUMBER() OVER (ORDER BY ${expression}) AS rn,
        COUNT(*) OVER () AS n FROM normalized ${where} AND ${expression} IS NOT NULL
    ) SELECT AVG(v) AS a FROM ranked
      WHERE rn IN (CAST((n + 1) / 2 AS INTEGER), CAST((n + 2) / 2 AS INTEGER))`;
  }
  const { off, limit } = trimWindow(count);
  if (off === 0) return `SELECT AVG(${expression}) AS a FROM normalized ${where}`;
  return `SELECT AVG(v) AS a FROM (
    SELECT ${expression} AS v FROM normalized ${where}
      AND ${expression} IS NOT NULL ORDER BY ${expression} LIMIT ${limit} OFFSET ${off}
  )`;
}

function bucketExpressions(dimension: SeasonalAverageDimension) {
  const column = dimension === "hours" ? "hours" : "pmc_raids";
  const lo = dimension === "hours"
    ? `CASE WHEN ${column} >= 10000 THEN 10000 WHEN ${column} < 2000
        THEN CAST(${column} / 50 AS INTEGER) * 50
        ELSE 2000 + CAST((${column} - 2000) / 100 AS INTEGER) * 100 END`
    : `CASE WHEN ${column} >= 3000 THEN 3000 WHEN ${column} < 1000
        THEN CAST(${column} / 25 AS INTEGER) * 25
        ELSE 1000 + CAST((${column} - 1000) / 50 AS INTEGER) * 50 END`;
  const hi = dimension === "hours"
    ? `CASE WHEN ${column} >= 10000 THEN NULL WHEN ${column} < 2000 THEN ${lo} + 50 ELSE ${lo} + 100 END`
    : `CASE WHEN ${column} >= 3000 THEN NULL WHEN ${column} < 1000 THEN ${lo} + 25 ELSE ${lo} + 50 END`;
  return { column, lo, hi };
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
    const d1 = await getSeasonalD1();
    let backend: AverageBackend;
    if (d1) {
      backend = { kind: "d1", db: d1 };
    } else {
      if (!database) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sqlite = (await import("node:sqlite" as string)) as any;
        database = new sqlite.DatabaseSync(
          process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db",
        );
        initializeSeasonalSchema(database);
      }
      backend = { kind: "sqlite", db: database };
    }

    return async (input) => {
      const now = input.now ?? Date.now();
      const metricDef = resolveY(input.metric);
      const metric = metricDef.key;

      const baseParams = (extra: unknown[] = []) => [input.cycleId, input.cycleId, input.cycleId, ...extra];
      const populationParams: unknown[] = [];
      const populationWhere = periodWhere(input.period, populationParams, now);
      const population = await backendFirst(backend,
        `${PORTRAIT_CTE} SELECT COUNT(*) AS n FROM normalized${populationWhere.length ? ` WHERE ${populationWhere.join(" AND ")}` : ""}`,
        baseParams(populationParams),
      );
      const total = Number(population?.n ?? 0);

      const rangeParams: unknown[] = [];
      const rangeWhere = periodWhere(input.period, rangeParams, now);
      appendRange(rangeWhere, rangeParams, input.dimension, input.min, input.max);
      const scopedWhere = rangeWhere.length ? ` WHERE ${rangeWhere.join(" AND ")}` : "";
      const scopedCount = await backendFirst(backend,
        `${PORTRAIT_CTE} SELECT COUNT(*) AS n FROM normalized${scopedWhere}`,
        baseParams(rangeParams),
      );
      const averages = { n: Number(scopedCount?.n ?? 0) } as NonNullable<AverageDashboardResponse["averages"]>;
      const metricCounts: Record<string, number> = {};
      for (const column of SEASONAL_AVG_COLS) {
        const metricParams: unknown[] = [];
        const metricWhereParts = periodWhere(input.period, metricParams, now);
        appendRange(metricWhereParts, metricParams, input.dimension, input.min, input.max);
        const metricExpr = metricExpression(column);
        const count = await backendFirst(backend,
          `${PORTRAIT_CTE} SELECT COUNT(${metricExpr}) AS n FROM normalized${metricWhereParts.length ? ` WHERE ${metricWhereParts.join(" AND ")}` : ""}`,
          baseParams(metricParams),
        );
        const n = Number(count?.n ?? 0);
        metricCounts[column] = n;
        if (n === 0) {
          averages[column] = null;
          continue;
        }
        const statisticParams: unknown[] = [];
        const statisticWhereParts = periodWhere(input.period, statisticParams, now);
        appendRange(statisticWhereParts, statisticParams, input.dimension, input.min, input.max);
        const statisticWhere = statisticWhereParts.length ? `WHERE ${statisticWhereParts.join(" AND ")}` : "";
        const value = await backendFirst(backend,
          `${PORTRAIT_CTE} ${averageSql(metricExpr, statisticWhere || "WHERE 1 = 1", input.statistic, n)}`,
          baseParams(statisticParams),
        );
        averages[column] = readNumber(value ?? undefined, "a");
        if (column === "hours" && input.metric === "hours") averages.hours = averages[column];
      }
      const rangeMetricExpr = metricDef.agg === "count" ? null : metricExpression(metricDef.column ?? metric);
      const { column: dimensionColumn, lo, hi } = bucketExpressions(input.dimension);
      const bucketParams: unknown[] = [];
      const bucketWhereParts = periodWhere(input.period, bucketParams, now);
      bucketWhereParts.push(`${dimensionColumn} IS NOT NULL`);
      if (rangeMetricExpr) bucketWhereParts.push(`${rangeMetricExpr} IS NOT NULL`);
      const bucketWhere = bucketWhereParts.length ? `WHERE ${bucketWhereParts.join(" AND ")}` : "";
      const bucketSql = rangeMetricExpr && input.statistic === "median"
        ? `${PORTRAIT_CTE}, bucketed AS (
            SELECT ${lo} AS lo, ${hi} AS hi, ${rangeMetricExpr} AS value
            FROM normalized ${bucketWhere}
          ), ranked AS (
            SELECT lo, hi, value,
              ROW_NUMBER() OVER (PARTITION BY lo, hi ORDER BY value) AS rn,
              COUNT(*) OVER (PARTITION BY lo, hi) AS bucket_n
            FROM bucketed
          ) SELECT lo, hi, MAX(bucket_n) AS n,
            COALESCE(SUM(CASE WHEN rn IN (
              CAST((bucket_n + 1) / 2 AS INTEGER), CAST((bucket_n + 2) / 2 AS INTEGER)
            ) THEN value END) / NULLIF(COUNT(CASE WHEN rn IN (
              CAST((bucket_n + 1) / 2 AS INTEGER), CAST((bucket_n + 2) / 2 AS INTEGER)
            ) THEN 1 END), 0) * MAX(bucket_n), 0) AS s
            FROM ranked GROUP BY lo, hi ORDER BY lo`
        : `${PORTRAIT_CTE} SELECT ${lo} AS lo, ${hi} AS hi, COUNT(*) AS n,
            ${rangeMetricExpr ? `COALESCE(SUM(${rangeMetricExpr}), 0)` : "0"} AS s
            FROM normalized ${bucketWhere} GROUP BY ${lo}, ${hi} ORDER BY lo`;
      const bucketRows = await backendRows(backend,
        bucketSql,
        baseParams(bucketParams),
      );
      const boundsParams: unknown[] = [];
      const boundsWhere = periodWhere(input.period, boundsParams, now);
      const boundsColumn = dimensionColumn;
      const bounds = await backendFirst(backend,
        `${PORTRAIT_CTE} SELECT MIN(${boundsColumn}) AS lo, MAX(${boundsColumn}) AS hi FROM normalized${[...boundsWhere, `${boundsColumn} IS NOT NULL`].length ? ` WHERE ${[...boundsWhere, `${boundsColumn} IS NOT NULL`].join(" AND ")}` : ""}`,
        baseParams(boundsParams),
      );
      return {
        mode: "seasonal",
        cycleId: input.cycleId,
        period: input.period,
        statistic: input.statistic,
        total,
        averages: total === 0 ? null : averages,
        metricCounts,
        buckets: bucketRows.map((row) => ({ lo: Number(row.lo), hi: row.hi == null ? null : Number(row.hi), n: Number(row.n), sum: Number(row.s ?? 0) })),
        bounds: bounds?.lo == null || bounds?.hi == null
          ? DEFAULT_BOUNDS[input.dimension]
          : { min: Math.max(0, Math.floor(Number(bounds.lo))), max: Math.ceil(Number(bounds.hi)) },
        dimension: input.dimension,
        metric,
      };
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
): Promise<SeasonalAchievementBaseline | null> {
  try {
    const d1 = await getSeasonalD1();
    let backend: AverageBackend;
    if (d1) backend = { kind: "d1", db: d1 };
    else {
      if (!database) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sqlite = (await import("node:sqlite" as string)) as any;
        database = new sqlite.DatabaseSync(process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db");
        initializeSeasonalSchema(database);
      }
      backend = { kind: "sqlite", db: database };
    }
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
        AND (latest.pmc_raids >= 1 OR latest.scav_raids >= 1)
        AND latest.achievements IS NOT NULL AND json_valid(latest.achievements)`,
      [cycleId, cycleId, cycleId, cycleId]);

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

/**
 * Builds a Seasonal-only numeric baseline for the risk model. It deliberately
 * reads the latest current-cycle Seasonal snapshots instead of the regular
 * PlayerStore, even when a caller also has a regular store available.
 */
export async function getSeasonalRiskBaseline(
  cycleId: string,
  minHours: number,
  maxHours: number | null,
): Promise<Baseline | null> {
  try {
    const d1 = await getSeasonalD1();
    let backend: AverageBackend;
    if (d1) backend = { kind: "d1", db: d1 };
    else {
      if (!database) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sqlite = (await import("node:sqlite" as string)) as any;
        database = new sqlite.DatabaseSync(process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db");
        initializeSeasonalSchema(database);
      }
      backend = { kind: "sqlite", db: database };
    }
    const range = maxHours === null
      ? "p.lifetime_pvp_hours >= ?"
      : "p.lifetime_pvp_hours >= ? AND p.lifetime_pvp_hours < ?";
    const params = maxHours === null
      ? [cycleId, cycleId, cycleId, minHours]
      : [cycleId, cycleId, cycleId, minHours, maxHours];
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
    ) SELECT latest.pmc_raids, latest.pmc_survived, latest.pmc_deaths,
        latest.pmc_kills, latest.killed_pmc, latest.longest_win_streak,
        latest.prestige, p.lifetime_pvp_hours AS hours
      FROM player_profiles p
      JOIN latest ON latest.aid = p.aid
        AND latest.mode = p.mode AND latest.cycle_id = p.cycle_id
      WHERE p.mode = 'seasonal' AND p.cycle_id = ? AND p.confirmed_banned = 0
        AND NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = p.aid)
        AND latest.pmc_raids >= 1 AND ${range}`,
      params);
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
    const baseline: Baseline = {
      n: rows.length,
      metrics: Object.fromEntries(Object.entries(metrics).flatMap(([key, values]) => {
        const result = meanStd(values);
        return result ? [[key, result]] : [];
      })),
    };
    return baseline;
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
    const d1 = await getSeasonalD1();
    const configuredCycle = loadSeasonalCycleConfig();
    if (d1) {
      if (configuredCycle) await upsertD1SeasonCycle(d1, configuredCycle);
      return async (cycleId, now = Date.now()) => {
        const cycle = await d1.prepare(
          "SELECT starts_at FROM season_cycles WHERE mode = 'seasonal' AND cycle_id = ?"
        ).bind(cycleId).first() as { starts_at: number } | null;
        if (!cycle) return null;
        const [population, distributionResult, ...dailyResults] = await Promise.all([
          d1.prepare(SEASONAL_POPULATION_SQL).bind(...seasonalPopulationArgs(cycleId, now)).first() as Promise<SeasonalPopulationRow | null>,
          d1.prepare(LIFETIME_BAND_DISTRIBUTION_SQL).bind("seasonal", cycleId).all(),
          ...KINDS.map((kind) => d1.prepare(progressionDailySql(kind))
            .bind("seasonal", cycleId, "seasonal", cycleId, -1).all()),
        ]);
        const distribution = lifetimeBandDistribution(
          d1Rows(distributionResult) as unknown as LifetimeBandCountRow[]
        );
        const series = Object.fromEntries(KINDS.map((kind, index) => [
          kind,
          buildSeasonalAverageSeries(
            d1Rows(dailyResults[index]) as unknown as DailyRow[],
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
    }

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
