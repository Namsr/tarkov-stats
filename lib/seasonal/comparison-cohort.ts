/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-ignore Node's strip-types test runner requires explicit extensions.
import { getSeasonalD1, type D1DatabaseLike } from "./d1.ts";
// @ts-ignore Node's strip-types test runner requires explicit extensions.
import { initializeSeasonalSchema } from "./storage.ts";
import type { AveragePeriod, AverageStatistic } from "../db";
import {
  COMPARISON_COHORT_PERCENTAGES,
  COMPARISON_COHORT_TARGET,
  COMPARISON_RADAR_METRICS,
  comparisonRangeFor,
  makeComparisonCohortResult,
  type ComparisonActualRanges,
  type ComparisonCohortPercent,
  type ComparisonCohortResult,
// @ts-ignore Node's strip-types test runner resolves the explicit .ts extension.
} from "../profile-cohort.ts";

type Backend = {
  kind: "d1" | "sqlite";
  db: D1DatabaseLike;
};

type Row = Record<string, unknown>;

let sqliteDatabase: D1DatabaseLike | null = null;

const SEASONAL_PORTRAIT_CTE = `
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
    latest.longest_win_streak AS longest_win_streak,
    latest.level AS level,
    latest.pmc_survived AS pmc_survived,
    latest.pmc_deaths AS pmc_deaths
  FROM player_profiles p
  JOIN latest ON latest.aid = p.aid
    AND latest.mode = p.mode AND latest.cycle_id = p.cycle_id
  WHERE p.mode = 'seasonal' AND p.cycle_id = ?
    AND p.confirmed_banned = 0
    AND p.lifetime_pvp_hours IS NOT NULL
    AND latest.pmc_raids IS NOT NULL AND latest.pmc_raids > 0
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

function trimWindow(n: number) {
  if (n < 20) return { trim: false, offset: 0, limit: n };
  const offset = Math.floor(n * 0.05);
  return offset > 0
    ? { trim: true, offset, limit: n - offset * 2 }
    : { trim: false, offset: 0, limit: n };
}

async function backend(): Promise<Backend | null> {
  const d1 = await getSeasonalD1();
  if (d1) return { kind: "d1", db: d1 };
  try {
    if (!sqliteDatabase) {
      // @ts-ignore Node's strip-types runtime resolves this built-in in self-hosted mode.
      const sqlite = (await import("node:sqlite" as string)) as { DatabaseSync: new (path: string) => D1DatabaseLike };
      sqliteDatabase = new sqlite.DatabaseSync(
        process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db",
      );
      initializeSeasonalSchema(sqliteDatabase);
    }
    return { kind: "sqlite", db: sqliteDatabase };
  } catch {
    return null;
  }
}

async function first(backend: Backend, sql: string, params: unknown[]): Promise<Row | null> {
  if (backend.kind === "d1") {
    return await backend.db.prepare(sql).bind(...params).first() as Row | null;
  }
  return backend.db.prepare(sql).get(...params) as Row | null;
}

function baseParams(cycleId: string, extra: unknown[] = []) {
  return [cycleId, cycleId, cycleId, ...extra];
}

function rangeWhere(input: {
  cycleId: string;
  center: { hours: number; pmcRaids: number };
  percent: ComparisonCohortPercent;
  excludeAid: number;
  period: AveragePeriod;
  now: number;
}) {
  const range = comparisonRangeFor(input.center, input.percent);
  const hoursMin = range.hours.min;
  const hoursMax = range.hours.max;
  const raidsMin = range.pmcRaids.min;
  const raidsMax = range.pmcRaids.max;
  const where = [
    "hours > 0",
    "pmc_raids > 0",
    "hours >= ?",
    "hours <= ?",
    "pmc_raids >= ?",
    "pmc_raids <= ?",
    "aid != ?",
  ];
  const params: unknown[] = [hoursMin, hoursMax, raidsMin, raidsMax, input.excludeAid];
  if (input.period === "90d") {
    where.push("profile_updated_at >= ?");
    params.push(Math.floor(input.now - 90 * 86_400_000));
  }
  return {
    where: `WHERE ${where.join(" AND ")}`,
    params,
    bounds: {
      hours: { min: hoursMin, max: hoursMax },
      pmcRaids: { min: raidsMin, max: raidsMax },
    },
  };
}

function metricSql(
  metric: string,
  where: string,
  statistic: AverageStatistic,
  count: number,
) {
  if (statistic === "median") {
    return `${SEASONAL_PORTRAIT_CTE}, ranked AS (
      SELECT ${metric} AS v, ROW_NUMBER() OVER (ORDER BY ${metric}) AS rn,
        COUNT(*) OVER () AS n
      FROM normalized ${where} AND ${metric} IS NOT NULL
    ) SELECT AVG(v) AS a FROM ranked
      WHERE rn IN (CAST((n + 1) / 2 AS INTEGER), CAST((n + 2) / 2 AS INTEGER))`;
  }
  const { offset, limit } = trimWindow(count);
  if (offset === 0) {
    return `${SEASONAL_PORTRAIT_CTE} SELECT AVG(${metric}) AS a FROM normalized ${where}`;
  }
  return `${SEASONAL_PORTRAIT_CTE} SELECT AVG(v) AS a FROM (
    SELECT ${metric} AS v FROM normalized ${where}
    ORDER BY ${metric} LIMIT ${limit} OFFSET ${offset}
  )`;
}

export interface SeasonalComparisonCohortInput {
  aid: number;
  cycleId: string;
  dimension?: "hours" | "pmc_raids";
  statistic?: AverageStatistic;
  period?: AveragePeriod;
  now?: number;
}

export interface SeasonalComparisonCohortLookup {
  available: boolean;
  result: ComparisonCohortResult | null;
}

/**
 * Computes the Seasonal comparison from the current cycle's latest snapshots.
 * The caller only supplies identity and presentation preferences; both centers
 * and all cohort rows are read from server-side Seasonal storage.
 */
export async function querySeasonalComparisonCohort(
  input: SeasonalComparisonCohortInput,
): Promise<SeasonalComparisonCohortLookup> {
  const store = await backend();
  if (!store) return { available: false, result: null };
  const dimension = input.dimension ?? "hours";
  const statistic = input.statistic ?? "trimmed_mean";
  const period = input.period ?? "all";
  const now = input.now ?? Date.now();
  const target = await first(store,
    `${SEASONAL_PORTRAIT_CTE} SELECT hours, pmc_raids FROM normalized WHERE aid = ? LIMIT 1`,
    baseParams(input.cycleId, [input.aid]),
  );
  if (!target || target.hours == null || target.pmc_raids == null) {
    return { available: true, result: null };
  }
  const center = { hours: Number(target.hours), pmcRaids: Number(target.pmc_raids) };
  if (!(center.hours > 0) || !(center.pmcRaids > 0)) {
    return {
      available: true,
      result: makeComparisonCohortResult({
        mode: "seasonal",
        cycleId: input.cycleId,
        aid: input.aid,
        center,
        dimension,
        percent: 30,
        n: 0,
        actualRanges: { hours: null, pmcRaids: null, raids: null },
        reason: "no_activity",
      }),
    };
  }

  const counts = Object.fromEntries(
    COMPARISON_COHORT_PERCENTAGES.map((percent) => [percent, 0])
  ) as Record<ComparisonCohortPercent, number>;
  for (const percent of COMPARISON_COHORT_PERCENTAGES) {
    const range = rangeWhere({ cycleId: input.cycleId, center, percent, excludeAid: input.aid, period, now });
    const row = await first(store,
      `${SEASONAL_PORTRAIT_CTE} SELECT COUNT(*) AS n FROM normalized ${range.where}`,
      baseParams(input.cycleId, range.params),
    );
    counts[percent] = Number(row?.n ?? 0);
  }
  const selectedPercent = COMPARISON_COHORT_PERCENTAGES.find((percent) =>
    counts[percent] >= COMPARISON_COHORT_TARGET
  ) ?? 30;
  const selected = rangeWhere({
    cycleId: input.cycleId,
    center,
    percent: selectedPercent,
    excludeAid: input.aid,
    period,
    now,
  });
  const group = await first(store,
    `${SEASONAL_PORTRAIT_CTE} SELECT COUNT(*) AS n,
      MIN(hours) AS hours_min, MAX(hours) AS hours_max,
      MIN(pmc_raids) AS raids_min, MAX(pmc_raids) AS raids_max
      FROM normalized ${selected.where}`,
    baseParams(input.cycleId, selected.params),
  );
  const n = Number(group?.n ?? 0);
  const actualRanges: ComparisonActualRanges = {
    hours: group?.hours_min == null || group?.hours_max == null
      ? null
      : { min: Number(group.hours_min), max: Number(group.hours_max) },
    pmcRaids: group?.raids_min == null || group?.raids_max == null
      ? null
      : { min: Number(group.raids_min), max: Number(group.raids_max) },
    raids: group?.raids_min == null || group?.raids_max == null
      ? null
      : { min: Number(group.raids_min), max: Number(group.raids_max) },
  };
  if (counts[selectedPercent] < COMPARISON_COHORT_TARGET || n < COMPARISON_COHORT_TARGET) {
    return {
      available: true,
      result: makeComparisonCohortResult({
        mode: "seasonal",
        cycleId: input.cycleId,
        aid: input.aid,
        center,
        dimension,
        percent: selectedPercent,
        n,
        actualRanges,
        reason: "insufficient_cohort",
      }),
    };
  }

  const averages = Object.fromEntries(
    COMPARISON_RADAR_METRICS.map((metric) => [metric, { value: null, count: 0 }])
  ) as ComparisonCohortResult["averages"];
  for (const metric of COMPARISON_RADAR_METRICS) {
    const metricCount = await first(store,
      `${SEASONAL_PORTRAIT_CTE} SELECT COUNT(${metric}) AS n FROM normalized ${selected.where}`,
      baseParams(input.cycleId, selected.params),
    );
    const count = Number(metricCount?.n ?? 0);
    const minimumPopulatedCount = metric === "pmc_survival_rate" ? 1 : COMPARISON_COHORT_TARGET;
    if (count < minimumPopulatedCount) {
      averages[metric] = { value: null, count };
      continue;
    }
    const row = await first(store,
      metricSql(metric, selected.where, statistic, count),
      baseParams(input.cycleId, selected.params),
    );
    averages[metric] = { value: row?.a == null ? null : Number(row.a), count };
  }
  return {
    available: true,
    result: makeComparisonCohortResult({
      mode: "seasonal",
      cycleId: input.cycleId,
      aid: input.aid,
      center,
      dimension,
      percent: selectedPercent,
      n,
      actualRanges,
      averages,
    }),
  };
}
