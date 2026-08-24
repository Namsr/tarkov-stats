// @ts-expect-error Node's strip-types worker requires explicit extensions; Next resolves them too.
import { buildProgressionMetricSeries, buildProgressionSeries, PROGRESSION_KINDS, progressionDailySql, queryPersistentProgressionAverage, queryProgressionSeriesBundle, type DailyRow, type ProgressionRequest } from "./progression.ts";
// @ts-expect-error Node's strip-types worker requires explicit extensions; Next resolves them too.
import { buildSequentialIntervals, DAY_MS, quantile } from "./analytics.ts";
// @ts-expect-error Node's strip-types worker requires explicit extensions; Next resolves them too.
import { d1Rows, getSeasonalD1, type D1DatabaseLike } from "./d1.ts";
// @ts-expect-error Node's strip-types worker requires explicit extensions; Next resolves them too.
import { loadSeasonalCycleConfig } from "./config.ts";
// @ts-expect-error Node's strip-types worker requires explicit extensions; Next resolves them too.
import { upsertD1SeasonCycle } from "./storage-d1.ts";
// @ts-expect-error Node's strip-types worker requires explicit extensions; Next resolves them too.
import { initializeSeasonalSchema, upsertSqliteSeasonCycle, parseSeasonalAchievementUnlocks } from "./storage.ts";
// @ts-expect-error Node's strip-types worker requires explicit extensions; Next resolves them too.
import { scoreCheater, type Baseline, type CheaterScoreResult } from "../cheater-score.ts";
// @ts-expect-error Node's strip-types worker requires explicit extensions; Next resolves them too.
import { PLAYTIME_RANGES, rangeForHours } from "../playtime-brackets.ts";
// @ts-expect-error Node's strip-types worker requires explicit extensions; Next resolves them too.
import { buildProgressionPercentileDistributions, buildSeasonalProgressionDetails, type ProgressionDetailIntervalRow, type ProgressionPercentileDistributions, type SeasonalProgressionDetails } from "./progression-details.ts";
import type { ParsedPlayerStats } from "../../types/tarkov";
import type {
  ProgressionAverageResponse,
  ProgressionKind,
  ProgressionMetricKey,
  ProgressionMetricSeries,
  ProgressionSeriesResponse,
  ProgressionTimelineResponse,
  SeasonalCounters,
} from "../../types/seasonal";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let database: any = null;

const SQLITE_READ_SCHEMA_PROBE = `SELECT
  (SELECT mode FROM progression_snapshots LIMIT 1) AS snapshot_mode,
  (SELECT confirmed_banned FROM player_profiles LIMIT 1) AS profile_ban,
  (SELECT tempo_score FROM progression_intervals LIMIT 1) AS interval_tempo,
  (SELECT generation FROM progression_materializations LIMIT 1) AS materialization_generation,
  (SELECT generation FROM progression_population_current LIMIT 1) AS population_generation,
  (SELECT payload FROM progression_population_generations LIMIT 1) AS population_payload,
  (SELECT payload FROM progression_population_chunks LIMIT 1) AS population_chunk,
  (SELECT revision FROM progression_personal_revisions LIMIT 1) AS personal_revision,
  (SELECT starts_at FROM season_cycles LIMIT 1) AS cycle_start,
  (SELECT aid FROM excluded_players LIMIT 1) AS excluded_aid`;

type ProgressionQueryResult = (ProgressionSeriesResponse & SeasonalProgressionDetails) | null;
type ProgressionIdentity = Omit<ProgressionRequest, "kind">;
export type ProgressionBundle = Record<ProgressionKind, Exclude<ProgressionQueryResult, null>>;

async function getSqliteProgressionDatabase() {
  if (!database) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sqlite = (await import("node:sqlite" as string)) as any;
    const opened = new sqlite.DatabaseSync(process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db");
    opened.exec("PRAGMA busy_timeout = 250");
    try {
      // The full initializer contains DDL/backfill writes; probe first so a
      // public read cannot contend with post-response profile capture.
      opened.prepare(SQLITE_READ_SCHEMA_PROBE).get();
    } catch (error) {
      if (!/no such table|no such column/i.test((error as Error).message)) {
        opened.close();
        throw error;
      }
      try {
        initializeSeasonalSchema(opened);
      } catch (initializationError) {
        opened.close();
        throw initializationError;
      }
    }
    database = opened;
  }
  return database;
}

interface DetailDbRow extends Record<string, unknown> {
  aid: number;
  local_date: string;
  ended_at: number;
  elapsed_days: number;
  status: "valid" | "reset" | "schema_anomaly";
  experience: number;
  pmc_raids: number;
  scav_raids: number;
  pmc_survived: number;
  pmc_deaths: number;
  pmc_kills: number;
  killed_pmc: number;
  pmc_killed_pmc: number | null;
}

interface StaticProfileRow extends Record<string, unknown> {
  nickname: string;
  experience: number;
  pmc_raids: number;
  scav_raids: number;
  pmc_survived: number;
  pmc_deaths: number;
  pmc_kills: number;
  killed_pmc: number;
  pmc_killed_pmc: number | null;
  pmc_kd_ratio: number | null;
  pvp_stats_known: number | null;
  lifetime_pvp_hours: number | null;
  prestige: number;
  longest_win_streak: number;
  achievements: string;
}

const DETAIL_INTERVAL_SQL = `SELECT i.aid, i.local_date, i.ended_at, i.elapsed_days, i.status,
    i.experience, i.pmc_raids, i.scav_raids, i.pmc_survived, i.pmc_deaths,
    i.pmc_kills, i.killed_pmc,
    CASE
      WHEN json_extract(to_s.stats_json, '$.pmcKilledPmc') IS NOT NULL
        AND json_extract(from_s.stats_json, '$.pmcKilledPmc') IS NOT NULL
        THEN json_extract(to_s.stats_json, '$.pmcKilledPmc') - json_extract(from_s.stats_json, '$.pmcKilledPmc')
      WHEN json_extract(to_s.stats_json, '$.pmcKdRatio') IS NOT NULL
        AND json_extract(from_s.stats_json, '$.pmcKdRatio') IS NOT NULL
        AND COALESCE(json_extract(to_s.stats_json, '$.pvpStatsKnown'), 1) != 0
        AND COALESCE(json_extract(from_s.stats_json, '$.pvpStatsKnown'), 1) != 0
        THEN json_extract(to_s.stats_json, '$.pmcKdRatio') * to_s.pmc_deaths
          - json_extract(from_s.stats_json, '$.pmcKdRatio') * from_s.pmc_deaths
      ELSE NULL
    END AS pmc_killed_pmc
  FROM progression_intervals i
  JOIN progression_snapshots to_s ON to_s.id = i.to_snapshot_id
  JOIN progression_snapshots from_s ON from_s.id = i.from_snapshot_id
  JOIN player_profiles p ON p.mode = i.mode AND p.cycle_id = i.cycle_id AND p.aid = i.aid
    AND p.confirmed_banned = 0
  WHERE i.mode = ? AND i.cycle_id = ? AND i.aid = ? AND i.status = 'valid'
  ORDER BY i.local_date, i.aid, i.ended_at`;

const STATIC_PROFILE_SQL = `SELECT p.nickname, p.experience, p.pmc_raids, p.scav_raids,
  p.pmc_survived, p.pmc_deaths, p.pmc_kills, p.killed_pmc,
  json_extract(s.stats_json, '$.pmcKilledPmc') AS pmc_killed_pmc,
  json_extract(s.stats_json, '$.pmcKdRatio') AS pmc_kd_ratio,
  json_extract(s.stats_json, '$.pvpStatsKnown') AS pvp_stats_known,
  p.lifetime_pvp_hours,
  COALESCE(s.prestige, 0) AS prestige,
  COALESCE(s.longest_win_streak, 0) AS longest_win_streak,
  COALESCE(s.achievements, '[]') AS achievements
  FROM player_profiles p LEFT JOIN progression_snapshots s ON s.id = (
    SELECT latest.id FROM progression_snapshots latest
    WHERE latest.mode = p.mode AND latest.cycle_id = p.cycle_id AND latest.aid = p.aid
    ORDER BY latest.profile_updated_at DESC, latest.id DESC LIMIT 1
  ) WHERE p.mode = ? AND p.cycle_id = ? AND p.aid = ?
    AND p.confirmed_banned = 0`;

/** Raw cumulative points and interval endpoints used by the combined timeline. */
const TIMELINE_SNAPSHOT_SQL = `SELECT s.aid, s.id AS point_id, s.local_date,
    s.profile_updated_at AS observed_at, s.experience, s.pmc_raids, s.level,
    s.pmc_survived, s.pmc_deaths, s.pmc_kills, s.killed_pmc, s.stats_json, s.series_id,
    COALESCE(p.lifetime_pvp_hours, s.hours) AS lifetime_hours
  FROM progression_snapshots s
  JOIN player_profiles p ON p.mode = s.mode AND p.cycle_id = s.cycle_id AND p.aid = s.aid
    AND p.confirmed_banned = 0
  WHERE s.mode = ? AND s.cycle_id = ? AND s.aid = ? AND s.pmc_raids > 0
  ORDER BY s.aid, s.profile_updated_at, s.id`;

const TIMELINE_INTERVAL_SQL = `SELECT i.aid, i.id AS point_id, i.local_date,
    i.ended_at AS observed_at, i.elapsed_days, i.status,
    i.experience AS delta_experience, i.pmc_raids AS delta_pmc_raids,
    i.scav_raids AS delta_scav_raids, i.pmc_survived AS delta_pmc_survived,
    i.pmc_deaths AS delta_pmc_deaths, i.pmc_kills AS delta_pmc_kills,
    i.killed_pmc AS delta_killed_pmc,
    CASE
      WHEN json_extract(to_s.stats_json, '$.pmcKilledPmc') IS NOT NULL
        AND json_extract(from_s.stats_json, '$.pmcKilledPmc') IS NOT NULL
        THEN json_extract(to_s.stats_json, '$.pmcKilledPmc') - json_extract(from_s.stats_json, '$.pmcKilledPmc')
      WHEN json_extract(to_s.stats_json, '$.pmcKdRatio') IS NOT NULL
        AND json_extract(from_s.stats_json, '$.pmcKdRatio') IS NOT NULL
        AND COALESCE(json_extract(to_s.stats_json, '$.pvpStatsKnown'), 1) != 0
        AND COALESCE(json_extract(from_s.stats_json, '$.pvpStatsKnown'), 1) != 0
        THEN json_extract(to_s.stats_json, '$.pmcKdRatio') * to_s.pmc_deaths
          - json_extract(from_s.stats_json, '$.pmcKdRatio') * from_s.pmc_deaths
      ELSE NULL
    END AS delta_pmc_killed_pmc,
    to_s.pmc_raids, to_s.level, to_s.series_id,
    from_s.profile_updated_at AS period_start_at,
    COALESCE(p.lifetime_pvp_hours, to_s.hours) AS lifetime_hours
  FROM progression_intervals i
  JOIN progression_snapshots to_s ON to_s.id = i.to_snapshot_id
  JOIN progression_snapshots from_s ON from_s.id = i.from_snapshot_id
  JOIN player_profiles p ON p.mode = i.mode AND p.cycle_id = i.cycle_id AND p.aid = i.aid
    AND p.confirmed_banned = 0
  WHERE i.mode = ? AND i.cycle_id = ? AND i.aid = ? AND i.status = 'valid' AND i.pmc_raids > 0
  ORDER BY i.aid, i.ended_at, i.id`;

const POPULATION_TIMELINE_SNAPSHOT_SQL = TIMELINE_SNAPSHOT_SQL.replace("AND s.aid = ? ", "")
  .replace("ORDER BY", "AND NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = s.aid) ORDER BY");
const POPULATION_TIMELINE_INTERVAL_SQL = TIMELINE_INTERVAL_SQL.replace("AND i.aid = ? ", "")
  .replace("ORDER BY", "AND NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = i.aid) ORDER BY");
const POPULATION_DETAIL_INTERVAL_SQL = DETAIL_INTERVAL_SQL.replace("AND i.aid = ? ", "")
  .replace("ORDER BY", "AND NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = i.aid) ORDER BY");

interface TimelineIntervalRow {
  aid: number;
  point_id: number;
  local_date: string;
  observed_at: number;
  elapsed_days: number;
  status: "valid" | "reset" | "schema_anomaly";
  delta_experience: number;
  delta_pmc_raids: number;
  delta_scav_raids: number;
  delta_pmc_survived: number;
  delta_pmc_deaths: number;
  delta_pmc_kills: number;
  delta_killed_pmc: number;
  delta_pmc_killed_pmc: number | null;
  pmc_raids: number;
  level: number | null;
  series_id: number;
  period_start_at: number | null;
  lifetime_hours: number | null;
}

/** Foreground timeline lines are cumulative profile values, not snapshot rates. */
const TIMELINE_CUMULATIVE_METRICS = [
  "survival", "pvp_kd", "ai_kd",
] as const satisfies readonly Exclude<ProgressionMetricKey, "xp">[];

/** Legacy rate lines remain in the response for old callers; the chart can
 * omit them because snapshot spacing is not a real active-day series. */
const TIMELINE_LEGACY_METRICS = [
  "xp_per_day", "pmc_raids_per_day", "pmc_kills_per_day", "non_pmc_kills_per_day",
  "pmc_kills_per_raid", "non_pmc_kills_per_raid",
] as const satisfies readonly Exclude<ProgressionMetricKey, "xp">[];

function finiteNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timelineSnapshotRows(rows: readonly Record<string, unknown>[]): DailyRow[] {
  return rows.flatMap((row) => {
    const value = finiteNumber(row.experience);
    const raids = finiteNumber(row.pmc_raids);
    const aid = finiteNumber(row.aid);
    const pointId = finiteNumber(row.point_id);
    const observedAt = finiteNumber(row.observed_at);
    const seriesId = finiteNumber(row.series_id);
    if (value == null || raids == null || raids <= 0 || aid == null || pointId == null || observedAt == null || seriesId == null) return [];
    return [{
      aid,
      point_id: pointId,
      local_date: String(row.local_date ?? ""),
      observed_at: observedAt,
      value,
      pmc_raids: raids,
      level: row.level == null ? null : finiteNumber(row.level),
      raid_bucket: Math.ceil(raids / 10) * 10,
      lifetime_hours: row.lifetime_hours == null ? null : finiteNumber(row.lifetime_hours),
      freshness_at: observedAt,
      confidence: 1,
      series_id: seriesId,
    } satisfies DailyRow];
  });
}

function zeroCounters(): SeasonalCounters {
  return {
    experience: 0,
    pmcRaids: 0,
    scavRaids: 0,
    pmcSurvived: 0,
    pmcDeaths: 0,
    pmcKills: 0,
    killedPmc: 0,
  };
}

function parseSnapshotStats(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function cumulativeMetricValue(
  row: Record<string, unknown>,
  metric: "survival" | "pvp_kd" | "ai_kd",
): number | null {
  const raids = finiteNumber(row.pmc_raids);
  const deaths = finiteNumber(row.pmc_deaths);
  const pmcKills = finiteNumber(row.pmc_kills);
  if (raids == null || raids < 0 || deaths == null || deaths < 0 || pmcKills == null || pmcKills < 0) return null;
  if (metric === "survival") {
    const survived = finiteNumber(row.pmc_survived);
    return survived == null || raids <= 0 ? null : Math.max(0, Math.min(100, survived / raids * 100));
  }
  const stats = parseSnapshotStats(row.stats_json);
  const exact = finiteNumber(stats.pmcKilledPmc);
  const known = stats.pvpStatsKnown !== false;
  const storedRatio = known ? finiteNumber(stats.pmcKdRatio) : null;
  // Seasonal rows predate stats_json and already store a PMC-only killed_pmc.
  const pvpKills = exact != null
    ? exact
    : storedRatio != null
      ? storedRatio * deaths
      : stats.pvpStatsKnown === undefined
        ? finiteNumber(row.killed_pmc)
        : null;
  if (pvpKills == null || pvpKills < 0) return null;
  if (metric === "pvp_kd") return deaths > 0 ? pvpKills / deaths : pvpKills;
  const pveKills = Math.max(0, pmcKills - pvpKills);
  return deaths > 0 ? pveKills / deaths : pveKills;
}

function timelineCumulativeMetricRows(
  rows: readonly Record<string, unknown>[],
  metric: "survival" | "pvp_kd" | "ai_kd",
): DailyRow[] {
  return rows.flatMap((raw) => {
    const value = cumulativeMetricValue(raw, metric);
    const aid = finiteNumber(raw.aid);
    const pointId = finiteNumber(raw.point_id);
    const observedAt = finiteNumber(raw.observed_at);
    const raids = finiteNumber(raw.pmc_raids);
    const seriesId = finiteNumber(raw.series_id);
    if (value == null || !Number.isFinite(value) || aid == null || pointId == null || observedAt == null || raids == null || raids <= 0 || seriesId == null) return [];
    return [{
      aid,
      point_id: pointId,
      local_date: String(raw.local_date ?? ""),
      observed_at: observedAt,
      value,
      pmc_raids: raids,
      raid_bucket: Math.ceil(raids / 10) * 10,
      lifetime_hours: raw.lifetime_hours == null ? null : finiteNumber(raw.lifetime_hours),
      freshness_at: observedAt,
      confidence: 1,
      series_id: seriesId,
      level: raw.level == null ? null : finiteNumber(raw.level),
    } satisfies DailyRow];
  });
}

function intervalMetricValues(row: TimelineIntervalRow): Record<typeof TIMELINE_LEGACY_METRICS[number], number | null> | null {
  const elapsedDays = finiteNumber(row.elapsed_days);
  if (row.status !== "valid" || elapsedDays == null || elapsedDays <= 0) return null;
  const changes: SeasonalCounters = {
    experience: Number(row.delta_experience),
    pmcRaids: Number(row.delta_pmc_raids),
    scavRaids: Number(row.delta_scav_raids),
    pmcSurvived: Number(row.delta_pmc_survived),
    pmcDeaths: Number(row.delta_pmc_deaths),
    pmcKills: Number(row.delta_pmc_kills),
    killedPmc: Number(row.delta_killed_pmc),
    ...(row.delta_pmc_killed_pmc == null ? {} : { pmcKilledPmc: Number(row.delta_pmc_killed_pmc) }),
  };
  if (!Object.values(changes).every(Number.isFinite)) return null;
  const interval = buildSequentialIntervals([
    { profileUpdatedAt: 0, counters: zeroCounters() },
    { profileUpdatedAt: elapsedDays * DAY_MS, counters: changes },
  ])[0];
  const metrics = interval?.status === "valid" ? interval.metrics : null;
  if (!metrics) return null;
  return {
    xp_per_day: metrics.xpPerDay,
    pmc_raids_per_day: metrics.pmcRaidsPerDay,
    pmc_kills_per_day: metrics.killedPmcPerDay,
    non_pmc_kills_per_day: metrics.nonPmcKillsPerDay,
    pmc_kills_per_raid: metrics.killedPmcPerRaid,
    non_pmc_kills_per_raid: metrics.nonPmcKillsPerRaid,
  };
}

function timelineLegacyMetricRows(
  rows: readonly Record<string, unknown>[],
  metric: typeof TIMELINE_LEGACY_METRICS[number],
): DailyRow[] {
  return rows.flatMap((raw) => {
    const row = raw as unknown as TimelineIntervalRow;
    const value = intervalMetricValues(row)?.[metric] ?? null;
    const aid = finiteNumber(row.aid);
    const pointId = finiteNumber(row.point_id);
    const observedAt = finiteNumber(row.observed_at);
    const raids = finiteNumber(row.pmc_raids);
    const seriesId = finiteNumber(row.series_id);
    if (value == null || !Number.isFinite(value) || aid == null || pointId == null || observedAt == null || raids == null || raids <= 0 || seriesId == null) return [];
    return [{
      aid,
      point_id: pointId,
      local_date: String(row.local_date ?? ""),
      observed_at: observedAt,
      value,
      pmc_raids: raids,
      raid_bucket: Math.ceil(raids / 10) * 10,
      lifetime_hours: row.lifetime_hours == null ? null : finiteNumber(row.lifetime_hours),
      freshness_at: observedAt,
      confidence: Math.max(0, Math.min(1, finiteNumber(row.elapsed_days) == null ? 0 : 1 / Math.max(1, Number(row.elapsed_days)))),
      series_id: seriesId,
      level: row.level == null ? null : finiteNumber(row.level),
      score_sample_n: null,
      period_start_at: row.period_start_at == null ? null : finiteNumber(row.period_start_at),
      elapsed_days: finiteNumber(row.elapsed_days),
      delta_experience: finiteNumber(row.delta_experience),
      delta_pmc_raids: finiteNumber(row.delta_pmc_raids),
    } satisfies DailyRow];
  });
}

function timelineMetricRows(
  snapshotRows: readonly Record<string, unknown>[],
  intervalRows: readonly Record<string, unknown>[],
): Partial<Record<ProgressionMetricKey, DailyRow[]>> {
  const metrics: Partial<Record<ProgressionMetricKey, DailyRow[]>> = {};
  const snapshots = timelineSnapshotRows(snapshotRows);
  if (snapshots.length) metrics.xp = snapshots;
  for (const metric of TIMELINE_CUMULATIVE_METRICS) {
    const source = timelineCumulativeMetricRows(snapshotRows, metric);
    if (source.length) metrics[metric] = source;
  }
  for (const metric of TIMELINE_LEGACY_METRICS) {
    const source = timelineLegacyMetricRows(intervalRows, metric);
    if (source.length) metrics[metric] = source;
  }
  return metrics;
}

function timelineMetricSeries(
  snapshotRows: readonly Record<string, unknown>[],
  intervalRows: readonly Record<string, unknown>[],
  identity: ProgressionIdentity,
): Partial<Record<ProgressionMetricKey, ProgressionMetricSeries>> {
  return Object.fromEntries(Object.entries(timelineMetricRows(snapshotRows, intervalRows)).map(([metric, rows]) => [
    metric,
    buildProgressionMetricSeries(rows, identity, metric as ProgressionMetricKey),
  ]));
}

interface PopulationMetricSnapshot {
  overall: ProgressionMetricSeries["overall"];
  byHours: Array<{
    min: number;
    max: number | null;
    points: ProgressionMetricSeries["overall"];
    n: number;
    confidence: number;
  }>;
  freshnessAt: number | null;
}

interface PopulationSnapshotPayload {
  metrics: Partial<Record<ProgressionMetricKey, PopulationMetricSnapshot>>;
  riskBaselines: Array<{ min: number; max: number | null; baseline: Baseline }>;
  achievementBaseline: {
    eligibleN: number;
    seasonStartsAt: number | null;
    achievements: Array<{
      id: string; owners: number; samplePct: number; meanHours: number; earlyHours: number;
      eligibleN: number; unlockDayP20: number | null; timestampOwners: number;
    }>;
  } | null;
  progressionPercentiles: ProgressionPercentileDistributions;
}

interface PublishedPopulationSnapshot {
  generation: number;
  generatedAt: number;
  payload: PopulationSnapshotPayload;
}

export const D1_POPULATION_CHUNK_CHARS = 250_000;

function payloadChunks(payload: string): string[] {
  return Array.from({ length: Math.ceil(payload.length / D1_POPULATION_CHUNK_CHARS) }, (_, index) =>
    payload.slice(index * D1_POPULATION_CHUNK_CHARS, (index + 1) * D1_POPULATION_CHUNK_CHARS));
}

const POPULATION_RISK_SQL = `SELECT p.lifetime_pvp_hours, s.pmc_raids, s.pmc_survived,
    s.pmc_deaths, s.pmc_kills, s.killed_pmc, s.longest_win_streak, s.prestige
  FROM player_profiles p JOIN progression_snapshots s ON s.id = (
    SELECT latest.id FROM progression_snapshots latest
    WHERE latest.mode = p.mode AND latest.cycle_id = p.cycle_id AND latest.aid = p.aid
    ORDER BY latest.profile_updated_at DESC, latest.id DESC LIMIT 1
  )
  WHERE p.mode = ? AND p.cycle_id = ? AND p.confirmed_banned = 0
    AND NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = p.aid)`;

const POPULATION_ACHIEVEMENT_SQL = `SELECT p.aid, p.lifetime_pvp_hours, s.achievements
  FROM player_profiles p JOIN progression_snapshots s ON s.id = (
    SELECT latest.id FROM progression_snapshots latest
    WHERE latest.mode = p.mode AND latest.cycle_id = p.cycle_id AND latest.aid = p.aid
    ORDER BY latest.profile_updated_at DESC, latest.id DESC LIMIT 1
  )
  WHERE p.mode = ? AND p.cycle_id = ? AND p.confirmed_banned = 0
    AND s.achievements IS NOT NULL AND json_valid(s.achievements)
    AND NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = p.aid)`;

function buildRiskBaseline(rows: readonly Record<string, unknown>[]): Baseline {
  const values: Record<string, number[]> = {
    pmc_survival_rate: [], pmc_kd_ratio: [], pmc_kills_per_raid: [], longest_win_streak: [], prestige: [],
  };
  for (const row of rows) {
    const raids = finiteNumber(row.pmc_raids);
    const survived = finiteNumber(row.pmc_survived);
    const deaths = finiteNumber(row.pmc_deaths);
    const killedPmc = finiteNumber(row.killed_pmc);
    const kills = finiteNumber(row.pmc_kills);
    if (raids == null || raids <= 0 || survived == null || deaths == null || killedPmc == null || kills == null) continue;
    values.pmc_survival_rate.push(survived / raids * 100);
    values.pmc_kd_ratio.push(deaths > 0 ? killedPmc / deaths : killedPmc);
    values.pmc_kills_per_raid.push(kills / raids);
    const streak = finiteNumber(row.longest_win_streak);
    const prestige = finiteNumber(row.prestige);
    if (streak != null) values.longest_win_streak.push(streak);
    if (prestige != null) values.prestige.push(prestige);
  }
  return {
    n: rows.length,
    metrics: Object.fromEntries(Object.entries(values).flatMap(([key, entries]) => {
      if (!entries.length) return [];
      const mean = entries.reduce((sum, value) => sum + value, 0) / entries.length;
      const variance = entries.reduce((sum, value) => sum + (value - mean) ** 2, 0) / entries.length;
      return [[key, { n: entries.length, mean, std: Math.sqrt(Math.max(0, variance)) }]];
    })),
  };
}

function percentile20(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * 0.2)] ?? null;
}

function buildAchievementBaseline(
  rows: readonly Record<string, unknown>[],
  seasonStartsAt: number | null,
): PopulationSnapshotPayload["achievementBaseline"] {
  const eligible = rows.flatMap((row) => {
    const achievements = parseSeasonalAchievementUnlocks(row.achievements);
    return achievements == null ? [] : [{ aid: Number(row.aid), hours: finiteNumber(row.lifetime_pvp_hours), achievements }];
  });
  if (!eligible.length) return null;
  const byAchievement = new Map<string, { owners: Set<number>; hours: number[]; unlockDays: number[] }>();
  for (const owner of eligible) {
    for (const achievement of owner.achievements) {
      const entry = byAchievement.get(achievement.id) ?? { owners: new Set<number>(), hours: [], unlockDays: [] };
      entry.owners.add(owner.aid);
      if (owner.hours != null && owner.hours >= 0) entry.hours.push(owner.hours);
      if (achievement.unlockedAt != null && seasonStartsAt != null) {
        const day = (achievement.unlockedAt - seasonStartsAt) / DAY_MS;
        if (Number.isFinite(day) && day >= 0) entry.unlockDays.push(day);
      }
      byAchievement.set(achievement.id, entry);
    }
  }
  return {
    eligibleN: eligible.length,
    seasonStartsAt,
    achievements: [...byAchievement.entries()].map(([id, value]) => {
      const meanHours = value.hours.length ? value.hours.reduce((sum, hours) => sum + hours, 0) / value.hours.length : 0;
      return {
        id, owners: value.owners.size, eligibleN: eligible.length,
        samplePct: value.owners.size / eligible.length * 100,
        meanHours, earlyHours: percentile20(value.hours) ?? meanHours,
        unlockDayP20: percentile20(value.unlockDays), timestampOwners: value.unlockDays.length,
      };
    }),
  };
}

function percentileGrid(
  distributions: ProgressionPercentileDistributions,
): ProgressionPercentileDistributions {
  return Object.fromEntries(Object.entries(distributions).map(([date, metrics]) => [
    date,
    Object.fromEntries(Object.entries(metrics).map(([metric, values]) => [
      metric,
      Array.from({ length: 101 }, (_, percentile) => quantile(values, percentile / 100) ?? 0),
    ])),
  ]));
}

function buildPopulationSnapshotPayload(
  snapshotRows: readonly Record<string, unknown>[],
  intervalRows: readonly Record<string, unknown>[],
  riskRows: readonly Record<string, unknown>[],
  achievementRows: readonly Record<string, unknown>[],
  detailIntervalRows: readonly DetailDbRow[],
  seasonStartsAt: number | null,
  mode: ProgressionIdentity["mode"],
  cycleId: string,
): PopulationSnapshotPayload {
  const identity = { mode, cycleId, aid: -1 };
  const source = timelineMetricRows(snapshotRows, intervalRows);
  const metricKeys: ProgressionMetricKey[] = ["xp", ...TIMELINE_CUMULATIVE_METRICS, ...TIMELINE_LEGACY_METRICS];
  const metrics = Object.fromEntries(metricKeys.map((metric) => {
    const rows = source[metric] ?? [];
    const overall = buildProgressionMetricSeries(rows, identity, metric);
    const byHours = PLAYTIME_RANGES.map((range) => {
      const scoped = rows.filter((row) => row.lifetime_hours != null && Number(row.lifetime_hours) >= range.min &&
        (range.max == null || Number(row.lifetime_hours) < range.max));
      const series = buildProgressionMetricSeries(scoped, identity, metric);
      return { min: range.min, max: range.max, points: series.overall, n: series.overall.at(-1)?.n ?? 0,
        confidence: series.overall.at(-1)?.confidence ?? 0 };
    });
    return [metric, { overall: overall.overall, byHours, freshnessAt: overall.freshnessAt }];
  })) as PopulationSnapshotPayload["metrics"];
  const riskBaselines = PLAYTIME_RANGES.map((range) => ({
    min: range.min,
    max: range.max,
    baseline: buildRiskBaseline(riskRows.filter((row) => {
      const hours = finiteNumber(row.lifetime_hours);
      return hours != null && hours >= range.min && (range.max == null || hours < range.max);
    })),
  }));
  return {
    metrics,
    riskBaselines,
    achievementBaseline: buildAchievementBaseline(achievementRows, seasonStartsAt),
    progressionPercentiles: percentileGrid(buildProgressionPercentileDistributions(
      detailRows(detailIntervalRows, { ...identity, kind: "cumulative" }),
    )),
  };
}

function parsePublishedPopulationSnapshot(row: Record<string, unknown> | null | undefined): PublishedPopulationSnapshot | null {
  if (!row?.payload || row.generation == null || row.generated_at == null) return null;
  try {
    const payload = JSON.parse(String(row.payload)) as PopulationSnapshotPayload;
    if (!payload || typeof payload !== "object" || !payload.metrics || !Array.isArray(payload.riskBaselines)) return null;
    return { generation: Number(row.generation), generatedAt: Number(row.generated_at), payload };
  } catch {
    return null;
  }
}

export function materializeSqlitePopulationSnapshot(
  db: { prepare(sql: string): { all(...args: unknown[]): Record<string, unknown>[]; get(...args: unknown[]): Record<string, unknown> | undefined; run(...args: unknown[]): unknown }; exec(sql: string): void },
  mode: ProgressionIdentity["mode"],
  cycleId: string,
  now = Date.now(),
): { generation: number; generatedAt: number } {
  initializeSeasonalSchema(db);
  const snapshots = db.prepare(POPULATION_TIMELINE_SNAPSHOT_SQL).all(mode, cycleId);
  const intervals = db.prepare(POPULATION_TIMELINE_INTERVAL_SQL).all(mode, cycleId);
  const riskRows = db.prepare(POPULATION_RISK_SQL).all(mode, cycleId);
  const achievementRows = db.prepare(POPULATION_ACHIEVEMENT_SQL).all(mode, cycleId);
  const detailIntervals = db.prepare(POPULATION_DETAIL_INTERVAL_SQL).all(mode, cycleId) as unknown as DetailDbRow[];
  const cycle = mode === "seasonal" ? db.prepare("SELECT starts_at FROM season_cycles WHERE mode = 'seasonal' AND cycle_id = ?").get(cycleId) : undefined;
  const payload = JSON.stringify(buildPopulationSnapshotPayload(snapshots, intervals, riskRows, achievementRows, detailIntervals,
    finiteNumber(cycle?.starts_at), mode, cycleId));
  const generation = now;
  db.exec("SAVEPOINT publish_progression_population");
  try {
    db.prepare(`INSERT INTO progression_population_generations
      (mode, cycle_id, generation, generated_at, payload) VALUES (?, ?, ?, ?, ?)`)
      .run(mode, cycleId, generation, now, payload);
    db.prepare(`INSERT INTO progression_population_current (mode, cycle_id, generation, generated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(mode, cycle_id) DO UPDATE SET
        generation = excluded.generation, generated_at = excluded.generated_at`)
      .run(mode, cycleId, generation, now);
    db.prepare(`DELETE FROM progression_population_generations WHERE mode = ? AND cycle_id = ?
      AND generation NOT IN (SELECT generation FROM progression_population_generations
        WHERE mode = ? AND cycle_id = ? ORDER BY generation DESC LIMIT 2)`)
      .run(mode, cycleId, mode, cycleId);
    db.exec("RELEASE publish_progression_population");
    return { generation, generatedAt: now };
  } catch (error) {
    db.exec("ROLLBACK TO publish_progression_population");
    db.exec("RELEASE publish_progression_population");
    throw error;
  }
}

export async function materializeD1PopulationSnapshot(
  db: D1DatabaseLike,
  mode: ProgressionIdentity["mode"],
  cycleId: string,
  now = Date.now(),
): Promise<{ generation: number; generatedAt: number }> {
  const [snapshots, intervals, risks, achievements, detailIntervals, cycle] = await Promise.all([
    db.prepare(POPULATION_TIMELINE_SNAPSHOT_SQL).bind(mode, cycleId).all(),
    db.prepare(POPULATION_TIMELINE_INTERVAL_SQL).bind(mode, cycleId).all(),
    db.prepare(POPULATION_RISK_SQL).bind(mode, cycleId).all(),
    db.prepare(POPULATION_ACHIEVEMENT_SQL).bind(mode, cycleId).all(),
    db.prepare(POPULATION_DETAIL_INTERVAL_SQL).bind(mode, cycleId).all(),
    mode === "seasonal"
      ? db.prepare("SELECT starts_at FROM season_cycles WHERE mode = 'seasonal' AND cycle_id = ?").bind(cycleId).first()
      : Promise.resolve(null),
  ]);
  const payload = JSON.stringify(buildPopulationSnapshotPayload(
    d1Rows(snapshots), d1Rows(intervals), d1Rows(risks), d1Rows(achievements),
    d1Rows(detailIntervals) as unknown as DetailDbRow[],
    finiteNumber((cycle as Record<string, unknown> | null)?.starts_at), mode, cycleId,
  ));
  const generation = now;
  const chunks = payloadChunks(payload);
  if (chunks.length > 90) throw new RangeError("progression population snapshot exceeds the D1 chunk budget");
  await db.batch([
    db.prepare(`INSERT INTO progression_population_generations
      (mode, cycle_id, generation, generated_at, payload) VALUES (?, ?, ?, ?, ?)`)
      .bind(mode, cycleId, generation, now, `chunks:${chunks.length}`),
    ...chunks.map((chunk, index) => db.prepare(`INSERT INTO progression_population_chunks
      (mode, cycle_id, generation, chunk_index, payload) VALUES (?, ?, ?, ?, ?)`)
      .bind(mode, cycleId, generation, index, chunk)),
    db.prepare(`INSERT INTO progression_population_current (mode, cycle_id, generation, generated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(mode, cycle_id) DO UPDATE SET
        generation = excluded.generation, generated_at = excluded.generated_at`)
      .bind(mode, cycleId, generation, now),
    db.prepare(`DELETE FROM progression_population_generations WHERE mode = ? AND cycle_id = ?
      AND generation NOT IN (SELECT generation FROM progression_population_generations
        WHERE mode = ? AND cycle_id = ? ORDER BY generation DESC LIMIT 2)`)
      .bind(mode, cycleId, mode, cycleId),
    db.prepare(`DELETE FROM progression_population_chunks WHERE mode = ? AND cycle_id = ?
      AND generation NOT IN (SELECT generation FROM progression_population_generations
        WHERE mode = ? AND cycle_id = ? ORDER BY generation DESC LIMIT 2)`)
      .bind(mode, cycleId, mode, cycleId),
  ]);
  return { generation, generatedAt: now };
}

function sqlitePopulationSnapshot(db: { prepare(sql: string): { get(...args: unknown[]): Record<string, unknown> | undefined } }, mode: ProgressionIdentity["mode"], cycleId: string) {
  return parsePublishedPopulationSnapshot(db.prepare(`SELECT g.generation, g.generated_at, g.payload
    FROM progression_population_current c JOIN progression_population_generations g
      ON g.mode = c.mode AND g.cycle_id = c.cycle_id AND g.generation = c.generation
    WHERE c.mode = ? AND c.cycle_id = ?`).get(mode, cycleId));
}

export async function d1PopulationSnapshot(db: D1DatabaseLike, mode: ProgressionIdentity["mode"], cycleId: string) {
  try {
    const row = await db.prepare(`SELECT g.generation, g.generated_at, g.payload
      FROM progression_population_current c JOIN progression_population_generations g
        ON g.mode = c.mode AND g.cycle_id = c.cycle_id AND g.generation = c.generation
      WHERE c.mode = ? AND c.cycle_id = ?`).bind(mode, cycleId).first() as Record<string, unknown> | null;
    if (!row || !String(row.payload ?? "").startsWith("chunks:")) return parsePublishedPopulationSnapshot(row);
    const result = await db.prepare(`SELECT payload FROM progression_population_chunks
      WHERE mode = ? AND cycle_id = ? AND generation = ? ORDER BY chunk_index`)
      .bind(mode, cycleId, row.generation).all();
    const chunks = d1Rows(result).map((entry) => String(entry.payload ?? ""));
    const expected = Number(String(row.payload).slice("chunks:".length));
    if (chunks.length !== expected) return null;
    return parsePublishedPopulationSnapshot({ ...row, payload: chunks.join("") });
  } catch (error) {
    if (/no such table|does not exist/i.test((error as Error).message)) return null;
    console.warn("progression population snapshot unavailable: " + (error as Error).message);
    return null;
  }
}

export interface PublishedSeasonalAchievementBaseline {
  eligibleN: number;
  achievements: Array<{
    id: string;
    owners: number;
    samplePct: number;
  }>;
}

/** Read the already-published two-hour achievement sample without rescanning players. */
export async function getPublishedSeasonalAchievementBaseline(
  cycleId: string,
): Promise<PublishedSeasonalAchievementBaseline | null> {
  try {
    const d1 = await getSeasonalD1();
    const population = d1
      ? await d1PopulationSnapshot(d1, "seasonal", cycleId)
      : sqlitePopulationSnapshot(await getSqliteProgressionDatabase(), "seasonal", cycleId);
    const baseline = population?.payload.achievementBaseline;
    if (!baseline) return null;
    return {
      eligibleN: baseline.eligibleN,
      achievements: baseline.achievements.map(({ id, owners, samplePct }) => ({ id, owners, samplePct })),
    };
  } catch (error) {
    console.warn("published Seasonal achievement baseline unavailable: " + (error as Error).message);
    return null;
  }
}

function detailRows(rows: readonly DetailDbRow[], input: ProgressionRequest): ProgressionDetailIntervalRow[] {
  return rows.map((row) => ({
    mode: input.mode,
    cycleId: input.cycleId,
    aid: Number(row.aid),
    localDate: String(row.local_date),
    endedAt: Number(row.ended_at),
    elapsedDays: Number(row.elapsed_days),
    status: row.status,
    changes: {
      experience: Number(row.experience),
      pmcRaids: Number(row.pmc_raids),
      scavRaids: Number(row.scav_raids),
      pmcSurvived: Number(row.pmc_survived),
      pmcDeaths: Number(row.pmc_deaths),
      pmcKills: Number(row.pmc_kills),
      killedPmc: Number(row.killed_pmc),
      ...(row.pmc_killed_pmc == null ? {} : { pmcKilledPmc: Number(row.pmc_killed_pmc) }),
    },
  }));
}

function achievementIds(value: string): string[] {
  return parseSeasonalAchievementUnlocks(value)?.map((achievement) => achievement.id) ?? [];
}

async function trustedStaticScore(
  row: StaticProfileRow,
  population: PublishedPopulationSnapshot | null,
): Promise<CheaterScoreResult> {
  const raids = Number(row.pmc_raids);
  const survived = Number(row.pmc_survived);
  const deaths = Number(row.pmc_deaths);
  const kills = Number(row.pmc_kills);
  const killedPmc = Number(row.killed_pmc);
  const exactPmcKilledPmc = finiteNumber(row.pmc_killed_pmc);
  const storedPmcKd = finiteNumber(row.pmc_kd_ratio);
  const pvpStatsKnown = Number(row.pvp_stats_known) !== 0 || exactPmcKilledPmc != null || storedPmcKd != null;
  const pvpKills = exactPmcKilledPmc
    ?? (pvpStatsKnown && storedPmcKd != null ? storedPmcKd * deaths : killedPmc);
  const ratio = (value: number, denominator: number) => denominator === 0 ? value : value / denominator;
  const stats: ParsedPlayerStats = {
    nickname: String(row.nickname), level: 0, prestige: Number(row.prestige), experience: Number(row.experience), side: "PMC",
    totalRaids: raids + Number(row.scav_raids), pmcRaids: raids, scavRaids: Number(row.scav_raids),
    survivedRaids: survived, survivalRate: raids > 0 ? (survived / raids) * 100 : 0,
    totalKills: kills, pmcKilledPmc: pvpKills, killedPmc, pvpStatsKnown,
    killsPerRaid: raids > 0 ? kills / raids : 0, kdRatio: ratio(kills, deaths),
    pmcKdRatio: ratio(pvpKills, deaths), deaths, pmcDeaths: deaths, runThrough: 0,
    pmcSurvived: survived, pmcSurvivalRate: raids > 0 ? (survived / raids) * 100 : 0,
    pmcKills: kills, pmcKillsPerRaid: raids > 0 ? kills / raids : 0, pmcExitKilled: 0, pmcExitLeft: 0,
    pmcExitTransit: 0, pmcExitMia: 0, hoursPlayed: Number(row.lifetime_pvp_hours ?? 0),
    longestWinStreak: Number(row.longest_win_streak), achievementsCount: achievementIds(row.achievements).length,
    registrationDate: 0, lastActiveDate: 0,
    avgLifespan: 0, totalLootValue: 0,
  };
  const bracket = rangeForHours(stats.hoursPlayed);
  const baseline = population?.payload.riskBaselines.find((entry) =>
    entry.min === bracket.min && entry.max === bracket.max)?.baseline ?? null;
  const achievementBaseline = population?.payload.achievementBaseline;
  const unlocks = parseSeasonalAchievementUnlocks(row.achievements) ?? [];
  const achievements = achievementBaseline ? {
    ownedIds: unlocks.map((achievement) => achievement.id),
    seasonal: true,
    playerUnlockDays: Object.fromEntries(unlocks
      .filter((achievement) => achievement.unlockedAt != null && achievementBaseline.seasonStartsAt != null)
      .map((achievement) => [achievement.id,
        (achievement.unlockedAt! - achievementBaseline.seasonStartsAt!) / DAY_MS])),
    stats: achievementBaseline.achievements.map((entry) => ({
      id: entry.id, owners: entry.owners, samplePct: entry.samplePct, meanHours: entry.meanHours,
      earlyHours: entry.earlyHours, eligibleN: entry.eligibleN,
      unlockDayP20: entry.timestampOwners < 1 ? null : entry.unlockDayP20,
    })),
  } : null;
  return scoreCheater(stats, baseline, achievements);
}

async function details(
  input: ProgressionRequest,
  intervals: DetailDbRow[],
  profile: StaticProfileRow,
  population: PublishedPopulationSnapshot | null = null,
): Promise<SeasonalProgressionDetails> {
  const staticRisk = await trustedStaticScore(profile, population);
  return buildSeasonalProgressionDetails({
    mode: input.mode,
    cycleId: input.cycleId,
    aid: input.aid,
    trustedStaticScore: staticRisk.score,
    staticReasons: staticRisk.factors.filter((factor) => factor.points >= 1).map((factor) => factor.key),
    intervals: detailRows(intervals, input),
    populationPercentiles: population?.payload.progressionPercentiles,
    comparisonsReady: population !== null,
  });
}

function progressionHistory(
  row: Record<string, unknown> | null | undefined,
  counts: Record<string, unknown> | null | undefined,
): ProgressionSeriesResponse["history"] {
  const allIntervalCount = Number(counts?.all_intervals ?? 0);
  const changedIntervalCount = Number(counts?.changed_intervals ?? 0);
  const raidIntervalCount = Number(counts?.raid_intervals ?? 0);
  const tempoPointCount = Number(counts?.tempo_points ?? 0);
  const formPointCount = Number(counts?.form_points ?? 0);
  return {
    snapshotCount: Number(row?.snapshots ?? 0),
    allIntervalCount,
    changedIntervalCount,
    raidIntervalCount,
    tempoPointCount,
    formPointCount,
    intervalCount: changedIntervalCount,
    ready: raidIntervalCount >= 2,
    firstObservedAt: row?.first_observed_at == null ? null : Number(row.first_observed_at),
    lastObservedAt: row?.last_observed_at == null ? null : Number(row.last_observed_at),
  };
}

function mergeProgressionBundle(
  series: Record<ProgressionKind, ProgressionSeriesResponse>,
  history: ProgressionSeriesResponse["history"],
  sharedDetails: SeasonalProgressionDetails,
): ProgressionBundle {
  return Object.fromEntries(PROGRESSION_KINDS.map((kind) => [
    kind,
    { ...series[kind], history, ...sharedDetails },
  ])) as ProgressionBundle;
}

type ProgressionTimelineQuery = (input: ProgressionIdentity) => Promise<ProgressionTimelineResponse | null>;

export async function assembleProgressionTimeline(
  input: ProgressionIdentity,
  snapshotRows: readonly Record<string, unknown>[],
  intervalRows: readonly Record<string, unknown>[],
  detailIntervalRows: readonly DetailDbRow[],
  profile: StaticProfileRow,
  historyRow: Record<string, unknown> | null | undefined,
  intervalCounts: Record<string, unknown> | null | undefined,
  cycleStartsAt: number | null,
  population: PublishedPopulationSnapshot | null,
): Promise<ProgressionTimelineResponse> {
  const metrics = timelineMetricSeries(snapshotRows, intervalRows, input);
  const hours = finiteNumber(profile.lifetime_pvp_hours);
  for (const [key, series] of Object.entries(metrics)) {
    const shared = population?.payload.metrics[key as ProgressionMetricKey];
    const nearby = hours == null ? null : shared?.byHours.find((entry) =>
      hours >= entry.min && (entry.max == null || hours < entry.max));
    series.overall = shared?.overall ?? [];
    series.nearby = nearby?.points ?? [];
    series.n = nearby?.n ?? 0;
    series.confidence = nearby?.confidence ?? 0;
    series.freshnessAt = Math.max(series.freshnessAt ?? 0, shared?.freshnessAt ?? 0) || null;
  }
  const history = progressionHistory(historyRow, intervalCounts);
  const detailInput = { ...input, kind: "cumulative" as const };
  const sharedDetails = await details(detailInput, [...detailIntervalRows], profile, population);
  const series = Object.values(metrics);
  const targetPoints = series.reduce((count, metric) => count + metric.player.length, 0);
  const confidence = metrics.xp?.confidence ?? series.at(-1)?.confidence ?? 0;
  const freshnessValues = series
    .map((metric) => metric.freshnessAt)
    .filter((value): value is number => value != null && Number.isFinite(value));
  return {
    identity: { mode: input.mode, cycleId: input.cycleId, aid: input.aid },
    axis: "pmc_raids",
    cycleStartsAt,
    metrics,
    history,
    risk: sharedDetails.risk,
    longTerm: sharedDetails.longTerm,
    n: targetPoints,
    confidence,
    freshnessAt: freshnessValues.length ? Math.max(...freshnessValues) : null,
    comparison: population
      ? { status: "ready", generation: population.generation, generatedAt: population.generatedAt }
      : { status: "warming", generation: null, generatedAt: null },
  };
}

/** Database-neutral query used by `/api/progression/timeline`. */
export async function getProgressionTimelineQuery(): Promise<ProgressionTimelineQuery | null> {
  try {
    const d1 = await getSeasonalD1();
    const configuredCycle = loadSeasonalCycleConfig();
    if (d1) {
      if (configuredCycle) await upsertD1SeasonCycle(d1, configuredCycle);
      return async (input) => {
        let cycleStartsAt: number | null = null;
        if (input.mode === "seasonal") {
          const cycle = await d1.prepare("SELECT starts_at FROM season_cycles WHERE mode = 'seasonal' AND cycle_id = ?")
            .bind(input.cycleId).first() as { starts_at: number } | null;
          if (!cycle) return null;
          const startsAt = Number(cycle.starts_at);
          cycleStartsAt = Number.isFinite(startsAt) ? startsAt : null;
        }
        const [snapshots, intervals, detailIntervals, profile, history, intervalCounts, population] = await Promise.all([
          d1.prepare(TIMELINE_SNAPSHOT_SQL).bind(input.mode, input.cycleId, input.aid).all(),
          d1.prepare(TIMELINE_INTERVAL_SQL).bind(input.mode, input.cycleId, input.aid).all(),
          d1.prepare(DETAIL_INTERVAL_SQL).bind(input.mode, input.cycleId, input.aid).all(),
          d1.prepare(STATIC_PROFILE_SQL).bind(input.mode, input.cycleId, input.aid).first() as Promise<StaticProfileRow | null>,
          d1.prepare(`SELECT COUNT(*) snapshots, MIN(profile_updated_at) first_observed_at,
              MAX(profile_updated_at) last_observed_at FROM progression_snapshots
            WHERE mode = ? AND cycle_id = ? AND aid = ?`).bind(input.mode, input.cycleId, input.aid).first(),
          d1.prepare(`SELECT COUNT(*) all_intervals,
              SUM(CASE WHEN status = 'valid' AND (experience != 0 OR pmc_raids != 0 OR scav_raids != 0
                OR pmc_survived != 0 OR pmc_deaths != 0 OR pmc_kills != 0 OR killed_pmc != 0) THEN 1 ELSE 0 END) changed_intervals,
              SUM(CASE WHEN status = 'valid' AND pmc_raids > 0 THEN 1 ELSE 0 END) raid_intervals,
              SUM(CASE WHEN status = 'valid' AND pmc_raids > 0 AND tempo_score IS NOT NULL THEN 1 ELSE 0 END) tempo_points,
              SUM(CASE WHEN status = 'valid' AND pmc_raids > 0 AND form_score IS NOT NULL THEN 1 ELSE 0 END) form_points
            FROM progression_intervals WHERE mode = ? AND cycle_id = ? AND aid = ?`)
            .bind(input.mode, input.cycleId, input.aid).first(),
          d1PopulationSnapshot(d1, input.mode, input.cycleId),
        ]);
        if (!profile) return null;
        return assembleProgressionTimeline(
          input,
          d1Rows(snapshots),
          d1Rows(intervals),
          d1Rows(detailIntervals) as unknown as DetailDbRow[],
          profile,
          history as Record<string, unknown> | null,
          intervalCounts as Record<string, unknown> | null,
          cycleStartsAt,
          population,
        );
      };
    }

    const sqliteDb = await getSqliteProgressionDatabase();
    if (configuredCycle) upsertSqliteSeasonCycle(sqliteDb, configuredCycle);
    return async (input) => {
      const profile = sqliteDb.prepare(STATIC_PROFILE_SQL).get(input.mode, input.cycleId, input.aid) as StaticProfileRow | undefined;
      if (!profile) return null;
      const cycleStartsAt = input.mode === "seasonal"
        ? Number((sqliteDb.prepare("SELECT starts_at FROM season_cycles WHERE mode = 'seasonal' AND cycle_id = ?")
          .get(input.cycleId) as { starts_at?: number } | undefined)?.starts_at)
        : null;
      const snapshots = sqliteDb.prepare(TIMELINE_SNAPSHOT_SQL).all(input.mode, input.cycleId, input.aid) as Record<string, unknown>[];
      const intervals = sqliteDb.prepare(TIMELINE_INTERVAL_SQL).all(input.mode, input.cycleId, input.aid) as Record<string, unknown>[];
      const detailIntervals = sqliteDb.prepare(DETAIL_INTERVAL_SQL)
        .all(input.mode, input.cycleId, input.aid) as DetailDbRow[];
      const history = sqliteDb.prepare(`SELECT COUNT(*) snapshots, MIN(profile_updated_at) first_observed_at,
          MAX(profile_updated_at) last_observed_at FROM progression_snapshots
        WHERE mode = ? AND cycle_id = ? AND aid = ?`).get(input.mode, input.cycleId, input.aid) as Record<string, unknown>;
      const intervalCounts = sqliteDb.prepare(`SELECT COUNT(*) all_intervals,
          SUM(CASE WHEN status = 'valid' AND (experience != 0 OR pmc_raids != 0 OR scav_raids != 0
            OR pmc_survived != 0 OR pmc_deaths != 0 OR pmc_kills != 0 OR killed_pmc != 0) THEN 1 ELSE 0 END) changed_intervals,
          SUM(CASE WHEN status = 'valid' AND pmc_raids > 0 THEN 1 ELSE 0 END) raid_intervals,
          SUM(CASE WHEN status = 'valid' AND pmc_raids > 0 AND tempo_score IS NOT NULL THEN 1 ELSE 0 END) tempo_points,
          SUM(CASE WHEN status = 'valid' AND pmc_raids > 0 AND form_score IS NOT NULL THEN 1 ELSE 0 END) form_points
        FROM progression_intervals WHERE mode = ? AND cycle_id = ? AND aid = ?`)
        .get(input.mode, input.cycleId, input.aid) as Record<string, unknown>;
      return assembleProgressionTimeline(input, snapshots, intervals, detailIntervals, profile, history, intervalCounts,
        Number.isFinite(cycleStartsAt) ? cycleStartsAt : null, sqlitePopulationSnapshot(sqliteDb, input.mode, input.cycleId));
    };
  } catch (error) {
    console.warn("progression timeline query unavailable: " + (error as Error).message);
    return null;
  }
}

export async function getProgressionBundleQuery(): Promise<((input: ProgressionIdentity) => Promise<ProgressionBundle | null>) | null> {
  try {
    const d1 = await getSeasonalD1();
    const configuredCycle = loadSeasonalCycleConfig();
    if (d1) {
      if (configuredCycle) await upsertD1SeasonCycle(d1, configuredCycle);
      return async (input) => {
        // D1 only owns the seasonal dataset. Returning null keeps persistent
        // modes from ever reading Seasonal population rows as a fallback.
        if (input.mode !== "seasonal") return null;
        const cycle = await d1.prepare("SELECT starts_at FROM season_cycles WHERE mode = 'seasonal' AND cycle_id = ?")
          .bind(input.cycleId).first() as { starts_at: number } | null;
        if (!cycle) return null;
        const [results, intervalResult, profile, history, intervalCounts] = await Promise.all([
          Promise.all(PROGRESSION_KINDS.map((kind) => d1.prepare(progressionDailySql(kind))
            .bind("seasonal", input.cycleId, "seasonal", input.cycleId, input.aid).all())),
          d1.prepare(DETAIL_INTERVAL_SQL).bind("seasonal", input.cycleId, input.aid).all(),
          d1.prepare(STATIC_PROFILE_SQL).bind("seasonal", input.cycleId, input.aid).first() as Promise<StaticProfileRow | null>,
          d1.prepare(`SELECT COUNT(*) snapshots, MIN(profile_updated_at) first_observed_at,
            MAX(profile_updated_at) last_observed_at FROM progression_snapshots
            WHERE mode = 'seasonal' AND cycle_id = ? AND aid = ?`).bind(input.cycleId, input.aid).first(),
          d1.prepare(`SELECT COUNT(*) all_intervals,
              SUM(CASE WHEN status = 'valid' AND (experience != 0 OR pmc_raids != 0 OR scav_raids != 0
                OR pmc_survived != 0 OR pmc_deaths != 0 OR pmc_kills != 0 OR killed_pmc != 0) THEN 1 ELSE 0 END) changed_intervals,
              SUM(CASE WHEN status = 'valid' AND pmc_raids > 0 THEN 1 ELSE 0 END) raid_intervals,
              SUM(CASE WHEN status = 'valid' AND pmc_raids > 0 AND tempo_score IS NOT NULL THEN 1 ELSE 0 END) tempo_points,
              SUM(CASE WHEN status = 'valid' AND pmc_raids > 0 AND form_score IS NOT NULL THEN 1 ELSE 0 END) form_points
            FROM progression_intervals WHERE mode = 'seasonal' AND cycle_id = ? AND aid = ?`)
            .bind(input.cycleId, input.aid).first(),
        ]);
        if (!profile) return null;
        const series = Object.fromEntries(PROGRESSION_KINDS.map((kind, index) => [
          kind,
          buildProgressionSeries(
            d1Rows(results[index]) as unknown as DailyRow[],
            { ...input, kind },
          ),
        ])) as Record<ProgressionKind, ProgressionSeriesResponse>;
        const detailInput = { ...input, kind: "cumulative" as const };
        return mergeProgressionBundle(
          series,
          progressionHistory(history as Record<string, unknown> | null, intervalCounts as Record<string, unknown> | null),
          await details(detailInput, d1Rows(intervalResult) as unknown as DetailDbRow[], profile),
        );
      };
    }
    const sqliteDb = await getSqliteProgressionDatabase();
    if (configuredCycle) upsertSqliteSeasonCycle(sqliteDb, configuredCycle);
    return async (input) => {
      const series = queryProgressionSeriesBundle(sqliteDb, input);
      if (!series) return null;
      const mode = input.mode;
      const profile = sqliteDb.prepare(STATIC_PROFILE_SQL).get(mode, input.cycleId, input.aid) as StaticProfileRow | undefined;
      if (!profile) return null;
      const intervals = sqliteDb.prepare(DETAIL_INTERVAL_SQL)
        .all(mode, input.cycleId, input.aid) as DetailDbRow[];
      const history = sqliteDb.prepare(`SELECT COUNT(*) snapshots, MIN(profile_updated_at) first_observed_at,
        MAX(profile_updated_at) last_observed_at FROM progression_snapshots
        WHERE mode = ? AND cycle_id = ? AND aid = ?`).get(mode, input.cycleId, input.aid) as Record<string, unknown>;
      const intervalCounts = sqliteDb.prepare(`SELECT COUNT(*) all_intervals,
          SUM(CASE WHEN status = 'valid' AND (experience != 0 OR pmc_raids != 0 OR scav_raids != 0
            OR pmc_survived != 0 OR pmc_deaths != 0 OR pmc_kills != 0 OR killed_pmc != 0) THEN 1 ELSE 0 END) changed_intervals,
          SUM(CASE WHEN status = 'valid' AND pmc_raids > 0 THEN 1 ELSE 0 END) raid_intervals,
          SUM(CASE WHEN status = 'valid' AND pmc_raids > 0 AND tempo_score IS NOT NULL THEN 1 ELSE 0 END) tempo_points,
          SUM(CASE WHEN status = 'valid' AND pmc_raids > 0 AND form_score IS NOT NULL THEN 1 ELSE 0 END) form_points
        FROM progression_intervals WHERE mode = ? AND cycle_id = ? AND aid = ?`)
        .get(mode, input.cycleId, input.aid) as Record<string, unknown>;
      const detailInput = { ...input, kind: "cumulative" as const };
      return mergeProgressionBundle(
        series,
        progressionHistory(history, intervalCounts),
        await details(detailInput, intervals, profile),
      );
    };
  } catch (error) {
    console.warn("progression query: sqlite unavailable: " + (error as Error).message);
    return null;
  }
}

export async function getLatestProgressionRevision(input: ProgressionIdentity): Promise<number | null> {
  try {
    const d1 = await getSeasonalD1();
    const row = d1
      ? await d1.prepare(`SELECT generation AS revision FROM progression_materializations
          WHERE mode = ? AND cycle_id = ?`)
        .bind(input.mode, input.cycleId).first() as Record<string, unknown> | null
      : await getSqliteProgressionDatabase().then((db) => db.prepare(
          `SELECT generation AS revision FROM progression_materializations
           WHERE mode = ? AND cycle_id = ?`,
        ).get(input.mode, input.cycleId) as Record<string, unknown> | undefined);
    return row?.revision == null ? 0 : Number(row.revision);
  } catch (error) {
    console.warn("progression revision unavailable: " + (error as Error).message);
    return null;
  }
}

export async function getProgressionTimelineRevisions(
  input: ProgressionIdentity,
): Promise<{ personalRevision: number; populationGeneration: number }> {
  try {
    const d1 = await getSeasonalD1();
    if (d1) {
      let personal: Record<string, unknown> | null = null;
      let population: Record<string, unknown> | null = null;
      try {
        personal = await d1.prepare(`SELECT revision FROM progression_personal_revisions
          WHERE mode = ? AND cycle_id = ? AND aid = ?`).bind(input.mode, input.cycleId, input.aid).first();
      } catch {
        personal = await d1.prepare(`SELECT COALESCE(MAX(id), 0) AS revision FROM progression_snapshots
          WHERE mode = ? AND cycle_id = ? AND aid = ?`).bind(input.mode, input.cycleId, input.aid).first();
      }
      try {
        population = await d1.prepare(`SELECT generation FROM progression_population_current
          WHERE mode = ? AND cycle_id = ?`).bind(input.mode, input.cycleId).first();
      } catch {
        population = null;
      }
      return { personalRevision: Number(personal?.revision ?? 0), populationGeneration: Number(population?.generation ?? 0) };
    }
    const db = await getSqliteProgressionDatabase();
    const personal = db.prepare(`SELECT revision FROM progression_personal_revisions
      WHERE mode = ? AND cycle_id = ? AND aid = ?`).get(input.mode, input.cycleId, input.aid) as Record<string, unknown> | undefined
      ?? db.prepare(`SELECT COALESCE(MAX(id), 0) AS revision FROM progression_snapshots
        WHERE mode = ? AND cycle_id = ? AND aid = ?`).get(input.mode, input.cycleId, input.aid) as Record<string, unknown>;
    const population = db.prepare(`SELECT generation FROM progression_population_current
      WHERE mode = ? AND cycle_id = ?`).get(input.mode, input.cycleId) as Record<string, unknown> | undefined;
    return { personalRevision: Number(personal?.revision ?? 0), populationGeneration: Number(population?.generation ?? 0) };
  } catch (error) {
    console.warn("progression timeline revisions unavailable: " + (error as Error).message);
    return { personalRevision: 0, populationGeneration: 0 };
  }
}

export async function getProgressionQuery(): Promise<((input: ProgressionRequest) => Promise<ProgressionQueryResult>) | null> {
  const queryBundle = await getProgressionBundleQuery();
  if (!queryBundle) return null;
  return async (input) => {
    const bundle = await queryBundle({
      mode: input.mode,
      cycleId: input.cycleId,
      aid: input.aid,
    });
    return bundle?.[input.kind] ?? null;
  };
}

export async function getRegularProgressionAverage(): Promise<ProgressionAverageResponse | null> {
  return getPersistentProgressionAverage("regular");
}

export async function getPersistentProgressionAverage(
  mode: Extract<import("../../types/seasonal").ProgressionMode, "regular" | "pve">,
): Promise<ProgressionAverageResponse | null> {
  try {
    if (await getSeasonalD1()) return null;
    return queryPersistentProgressionAverage(await getSqliteProgressionDatabase(), mode);
  } catch (error) {
    console.warn("persistent progression average unavailable: " + (error as Error).message);
    return null;
  }
}
