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

type Backend = { kind: "d1" | "sqlite"; db: D1DatabaseLike };
type Row = Record<string, unknown>;

const COHORT_CACHE_TTL_MS = 5 * 60_000;
const COHORT_CACHE_MAX = 512;
const cohortCache = new Map<string, { expiresAt: number; value: SeasonalComparisonCohortLookup }>();
const cohortLoads = new Map<string, Promise<SeasonalComparisonCohortLookup>>();
let sqliteDatabase: D1DatabaseLike | null = null;

const NORMALIZED_CTE = `
WITH normalized AS (
  SELECT aid, profile_updated_at, lifetime_pvp_hours AS hours, total_raids,
    pmc_raids, scav_raids, survived, deaths, total_kills, killed_pmc,
    longest_win_streak, level, pmc_survived, pmc_deaths,
    CASE WHEN total_raids > 0 THEN 100.0 * survived / total_raids END AS survival_rate,
    CASE WHEN deaths > 0 THEN 1.0 * total_kills / deaths ELSE total_kills END AS kd_ratio,
    CASE WHEN pmc_deaths > 0 THEN 1.0 * killed_pmc / pmc_deaths ELSE killed_pmc END AS pmc_kd_ratio,
    CASE WHEN total_raids > 0 THEN 1.0 * total_kills / total_raids END AS kills_per_raid,
    CASE WHEN pmc_raids > 0 THEN 100.0 * pmc_survived / pmc_raids END AS pmc_survival_rate
  FROM player_profiles
  WHERE mode = 'seasonal' AND cycle_id = ? AND confirmed_banned = 0
    AND lifetime_pvp_hours IS NOT NULL AND pmc_raids > 0
)
`;

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

async function first(store: Backend, sql: string, params: unknown[]): Promise<Row | null> {
  if (store.kind === "d1") return await store.db.prepare(sql).bind(...params).first() as Row | null;
  return store.db.prepare(sql).get(...params) as Row | null;
}

async function all(store: Backend, sql: string, params: unknown[]): Promise<Row[]> {
  if (store.kind === "d1") return d1Rows(await store.db.prepare(sql).bind(...params).all());
  return store.db.prepare(sql).all(...params) as Row[];
}

function rangeWhere(input: {
  center: { hours: number; pmcRaids: number };
  percent: ComparisonCohortPercent;
  excludeAid: number;
  period: AveragePeriod;
  now: number;
}) {
  const range = comparisonRangeFor(input.center, input.percent);
  const where = [
    "hours > 0", "pmc_raids > 0", "hours >= ?", "hours <= ?",
    "pmc_raids >= ?", "pmc_raids <= ?", "aid != ?",
  ];
  const params: unknown[] = [
    range.hours.min, range.hours.max, range.pmcRaids.min, range.pmcRaids.max, input.excludeAid,
  ];
  if (input.period === "90d") {
    where.push("profile_updated_at >= ?");
    params.push(Math.floor(input.now - 90 * 86_400_000));
  }
  return { where: `WHERE ${where.join(" AND ")}`, params };
}

function metricsSql(where: string, statistic: AverageStatistic): string {
  const selected = statistic === "median"
    ? "rn IN (CAST((n + 1) / 2 AS INTEGER), CAST((n + 2) / 2 AS INTEGER))"
    : `rn > CASE WHEN n >= 20 THEN CAST(n * 0.05 AS INTEGER) ELSE 0 END
       AND rn <= n - CASE WHEN n >= 20 THEN CAST(n * 0.05 AS INTEGER) ELSE 0 END`;
  const values = COMPARISON_RADAR_METRICS.map((metric) =>
    `SELECT '${metric}' AS metric, ${metric} AS v FROM cohort WHERE ${metric} IS NOT NULL`
  ).join(" UNION ALL ");
  return `${NORMALIZED_CTE}, cohort AS (
    SELECT * FROM normalized ${where}
  ), metric_values AS (${values}), ranked AS (
    SELECT metric, v, ROW_NUMBER() OVER (PARTITION BY metric ORDER BY v) AS rn,
      COUNT(*) OVER (PARTITION BY metric) AS n
    FROM metric_values
  )
  SELECT '__group__' AS metric, COUNT(*) AS n, NULL AS a,
    MIN(hours) AS hours_min, MAX(hours) AS hours_max,
    MIN(pmc_raids) AS raids_min, MAX(pmc_raids) AS raids_max
  FROM cohort
  UNION ALL
  SELECT metric, MAX(n) AS n, AVG(CASE WHEN ${selected} THEN v END) AS a,
    NULL, NULL, NULL, NULL
  FROM ranked GROUP BY metric`;
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

function cacheKey(input: SeasonalComparisonCohortInput, now: number): string {
  return [input.cycleId, input.aid, input.dimension ?? "hours", input.statistic ?? "trimmed_mean",
    input.period ?? "all", input.period === "90d" ? Math.floor(now / COHORT_CACHE_TTL_MS) : 0].join(":");
}

function cacheResult(key: string, value: SeasonalComparisonCohortLookup, now: number): void {
  for (const [cachedKey, entry] of cohortCache) {
    if (entry.expiresAt <= now) cohortCache.delete(cachedKey);
  }
  while (cohortCache.size >= COHORT_CACHE_MAX) {
    const oldest = cohortCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cohortCache.delete(oldest);
  }
  cohortCache.set(key, { expiresAt: now + COHORT_CACHE_TTL_MS, value });
}

async function computeSeasonalComparisonCohort(
  input: SeasonalComparisonCohortInput,
  now: number,
): Promise<SeasonalComparisonCohortLookup> {
  const store = await backend();
  if (!store) return { available: false, result: null };
  const dimension = input.dimension ?? "hours";
  const statistic = input.statistic ?? "trimmed_mean";
  const period = input.period ?? "all";
  const target = await first(store,
    `${NORMALIZED_CTE} SELECT hours, pmc_raids FROM normalized WHERE aid = ? LIMIT 1`,
    [input.cycleId, input.aid],
  );
  if (!target || target.hours == null || target.pmc_raids == null) return { available: true, result: null };
  const center = { hours: Number(target.hours), pmcRaids: Number(target.pmc_raids) };
  if (!(center.hours > 0) || !(center.pmcRaids > 0)) {
    return { available: true, result: makeComparisonCohortResult({
      mode: "seasonal", cycleId: input.cycleId, aid: input.aid, center, dimension,
      percent: 30, n: 0, actualRanges: { hours: null, pmcRaids: null, raids: null }, reason: "no_activity",
    }) };
  }

  const widest = rangeWhere({ center, percent: 30, excludeAid: input.aid, period, now });
  const countConditions = COMPARISON_COHORT_PERCENTAGES.map((percent) => {
    const range = comparisonRangeFor(center, percent);
    return { sql: "hours >= ? AND hours <= ? AND pmc_raids >= ? AND pmc_raids <= ?",
      params: [range.hours.min, range.hours.max, range.pmcRaids.min, range.pmcRaids.max] };
  });
  const countRow = await first(store,
    `${NORMALIZED_CTE} SELECT ${COMPARISON_COHORT_PERCENTAGES.map((percent, index) =>
      `SUM(CASE WHEN ${countConditions[index].sql} THEN 1 ELSE 0 END) AS count_${percent}`
    ).join(", ")} FROM normalized ${widest.where}`,
    [input.cycleId, ...countConditions.flatMap((condition) => condition.params), ...widest.params],
  );
  const counts = Object.fromEntries(COMPARISON_COHORT_PERCENTAGES.map((percent) => [
    percent, Number(countRow?.[`count_${percent}`] ?? 0),
  ])) as Record<ComparisonCohortPercent, number>;
  const selectedPercent = COMPARISON_COHORT_PERCENTAGES.find((percent) =>
    counts[percent] >= COMPARISON_COHORT_TARGET
  ) ?? 30;
  const selected = rangeWhere({ center, percent: selectedPercent, excludeAid: input.aid, period, now });
  const rows = await all(store, metricsSql(selected.where, statistic), [input.cycleId, ...selected.params]);
  const group = rows.find((row) => row.metric === "__group__");
  const n = Number(group?.n ?? 0);
  const actualRanges: ComparisonActualRanges = {
    hours: group?.hours_min == null || group?.hours_max == null ? null
      : { min: Number(group.hours_min), max: Number(group.hours_max) },
    pmcRaids: group?.raids_min == null || group?.raids_max == null ? null
      : { min: Number(group.raids_min), max: Number(group.raids_max) },
    raids: group?.raids_min == null || group?.raids_max == null ? null
      : { min: Number(group.raids_min), max: Number(group.raids_max) },
  };
  if (counts[selectedPercent] < COMPARISON_COHORT_TARGET || n < COMPARISON_COHORT_TARGET) {
    return { available: true, result: makeComparisonCohortResult({
      mode: "seasonal", cycleId: input.cycleId, aid: input.aid, center, dimension,
      percent: selectedPercent, n, actualRanges, reason: "insufficient_cohort",
    }) };
  }
  const metricRows = new Map(rows.map((row) => [String(row.metric), row]));
  const averages = Object.fromEntries(COMPARISON_RADAR_METRICS.map((metric) => {
    const row = metricRows.get(metric);
    const count = Number(row?.n ?? 0);
    const minimum = metric === "pmc_survival_rate" ? 1 : COMPARISON_COHORT_TARGET;
    return [metric, { value: count < minimum || row?.a == null ? null : Number(row.a), count }];
  })) as ComparisonCohortResult["averages"];
  return { available: true, result: makeComparisonCohortResult({
    mode: "seasonal", cycleId: input.cycleId, aid: input.aid, center, dimension,
    percent: selectedPercent, n, actualRanges, averages,
  }) };
}

/** Reads the Seasonal comparison in at most three SQL calls and shares identical work for five minutes. */
export async function querySeasonalComparisonCohort(
  input: SeasonalComparisonCohortInput,
): Promise<SeasonalComparisonCohortLookup> {
  const now = input.now ?? Date.now();
  const key = cacheKey(input, now);
  const cached = cohortCache.get(key);
  if (cached && cached.expiresAt > now) {
    cohortCache.delete(key);
    cohortCache.set(key, cached);
    return cached.value;
  }
  const existing = cohortLoads.get(key);
  if (existing) return existing;
  const load = computeSeasonalComparisonCohort(input, now).then((value) => {
    cacheResult(key, value, now);
    return value;
  }).finally(() => {
    if (cohortLoads.get(key) === load) cohortLoads.delete(key);
  });
  cohortLoads.set(key, load);
  return load;
}
