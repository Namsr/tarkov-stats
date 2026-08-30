/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-ignore Node's strip-types test runner requires explicit extensions.
import { d1Rows, getSeasonalD1, type D1DatabaseLike } from "./d1.ts";
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

async function rows(backend: Backend, sql: string, params: unknown[]): Promise<Row[]> {
  if (backend.kind === "d1") {
    return d1Rows(await backend.db.prepare(sql).bind(...params).all());
  }
  return backend.db.prepare(sql).all(...params) as Row[];
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

function finiteNumber(value: unknown): number | null {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function insideRange(
  row: Row,
  bounds: ReturnType<typeof comparisonRangeFor>,
): boolean {
  const hours = finiteNumber(row.hours);
  const pmcRaids = finiteNumber(row.pmc_raids);
  return hours !== null && pmcRaids !== null &&
    hours >= bounds.hours.min && hours <= bounds.hours.max &&
    pmcRaids >= bounds.pmcRaids.min && pmcRaids <= bounds.pmcRaids.max;
}

function aggregate(values: number[], statistic: AverageStatistic): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  if (statistic === "median") {
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
  }
  const { offset, limit } = trimWindow(sorted.length);
  const selected = sorted.slice(offset, offset + limit);
  return selected.reduce((sum, value) => sum + value, 0) / selected.length;
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

  // Load the widest candidate window once. The previous implementation rebuilt
  // the latest-snapshot CTE for every percentage, count, range and radar metric,
  // which turned one cohort response into up to 17 full database passes.
  const widest = rangeWhere({
    cycleId: input.cycleId,
    center,
    percent: 30,
    excludeAid: input.aid,
    period,
    now,
  });
  const candidates = await rows(store,
    `${SEASONAL_PORTRAIT_CTE} SELECT hours, pmc_raids, ${COMPARISON_RADAR_METRICS.join(", ")}
      FROM normalized ${widest.where}`,
    baseParams(input.cycleId, widest.params),
  );
  const counts = Object.fromEntries(COMPARISON_COHORT_PERCENTAGES.map((percent) => [
    percent,
    candidates.filter((row) => insideRange(row, comparisonRangeFor(center, percent))).length,
  ])) as Record<ComparisonCohortPercent, number>;
  const selectedPercent = COMPARISON_COHORT_PERCENTAGES.find((percent) =>
    counts[percent] >= COMPARISON_COHORT_TARGET
  ) ?? 30;
  const selectedRows = candidates.filter((row) =>
    insideRange(row, comparisonRangeFor(center, selectedPercent))
  );
  const n = selectedRows.length;
  const selectedHours = selectedRows.map((row) => finiteNumber(row.hours)!).sort((a, b) => a - b);
  const selectedRaids = selectedRows.map((row) => finiteNumber(row.pmc_raids)!).sort((a, b) => a - b);
  const actualRanges: ComparisonActualRanges = {
    hours: selectedHours.length === 0
      ? null
      : { min: selectedHours[0], max: selectedHours[selectedHours.length - 1] },
    pmcRaids: selectedRaids.length === 0
      ? null
      : { min: selectedRaids[0], max: selectedRaids[selectedRaids.length - 1] },
    raids: selectedRaids.length === 0
      ? null
      : { min: selectedRaids[0], max: selectedRaids[selectedRaids.length - 1] },
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
    const values = selectedRows.flatMap((row) => {
      const value = finiteNumber(row[metric]);
      return value === null ? [] : [value];
    });
    const count = values.length;
    const minimumPopulatedCount = metric === "pmc_survival_rate" ? 1 : COMPARISON_COHORT_TARGET;
    if (count < minimumPopulatedCount) {
      averages[metric] = { value: null, count };
      continue;
    }
    averages[metric] = { value: aggregate(values, statistic), count };
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
