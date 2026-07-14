// @ts-expect-error Node's strip-types test runner requires the extension; Next accepts it.
import { expandNearbyCohort, quantile, trimmedMean, weightedEightBandMean } from "./analytics.ts";
// @ts-expect-error Node's strip-types test runner requires the extension; Next accepts it.
import { LIFETIME_HOUR_BANDS } from "../../types/seasonal.ts";
import type {
  CohortDimension,
  ProgressionKind,
  ProgressionPoint,
  ProgressionSeriesResponse,
  SeasonalAverageSeries,
  SeasonalPopulationSummary,
} from "@/types/seasonal";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SqliteDatabase = any;

export interface ProgressionRequest {
  cycleId: string;
  aid: number;
  kind: ProgressionKind;
  dimension: CohortDimension;
  center: number;
}

const KINDS = new Set<ProgressionKind>(["cumulative", "tempo", "form"]);
const DIMENSIONS = new Set<CohortDimension>(["hours", "pmc_raids"]);

/** Strict public API validation: required, single-valued parameters only. */
export function parseProgressionRequest(params: URLSearchParams): ProgressionRequest | null {
  const allowed = new Set(["cycle", "aid", "kind", "dimension", "center"]);
  if ([...params.keys()].some((key) => !allowed.has(key))) return null;
  if ([...allowed].some((key) => params.getAll(key).length !== 1)) return null;
  const cycle = params.get("cycle")!.trim();
  const cycleId = /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(cycle) ? cycle : null;
  const aidText = params.get("aid")!;
  const centerText = params.get("center")!;
  const aid = Number(aidText);
  const center = Number(centerText);
  const kind = params.get("kind") as ProgressionKind;
  const dimension = params.get("dimension") as CohortDimension;
  if (!cycleId || !/^[1-9]\d*$/.test(aidText) || !Number.isSafeInteger(aid)) return null;
  if (centerText.trim() === "" || !Number.isFinite(center) || center < 0) return null;
  if (!KINDS.has(kind) || !DIMENSIONS.has(dimension)) return null;
  return { cycleId, aid, kind, dimension, center };
}

export interface DailyRow {
  aid: number;
  local_date: string;
  value: number;
  dimension_value: number | null;
  lifetime_hours: number | null;
  freshness_at: number;
  confidence: number;
  series_id: number;
}

export interface LifetimeBandCountRow {
  band: number;
  n: number;
}

const LIFETIME_BAND_CASE = `CASE
  WHEN lifetime_pvp_hours < 50 THEN 0 WHEN lifetime_pvp_hours < 100 THEN 1
  WHEN lifetime_pvp_hours < 200 THEN 2 WHEN lifetime_pvp_hours < 500 THEN 3
  WHEN lifetime_pvp_hours < 1000 THEN 4 WHEN lifetime_pvp_hours < 2000 THEN 5
  WHEN lifetime_pvp_hours < 5000 THEN 6 ELSE 7 END`;

/** Full cross-sectional base used for overall weighting, independent of longitudinal eligibility. */
export const LIFETIME_BAND_DISTRIBUTION_SQL = `SELECT ${LIFETIME_BAND_CASE} AS band, COUNT(*) AS n
  FROM player_profiles
  WHERE mode = 'seasonal' AND cycle_id = ? AND confirmed_banned = 0
    AND (pmc_raids >= 1 OR scav_raids >= 1) AND lifetime_pvp_hours IS NOT NULL
  GROUP BY band`;

export function lifetimeBandDistribution(rows: readonly LifetimeBandCountRow[]): number[] {
  const counts = Array(8).fill(0) as number[];
  for (const row of rows) {
    const band = Number(row.band);
    const n = Number(row.n);
    if (Number.isInteger(band) && band >= 0 && band < counts.length && Number.isFinite(n) && n >= 0) {
      counts[band] = n;
    }
  }
  return counts;
}

export interface SeasonalPopulationRow {
  n: number;
  freshness_at: number | null;
  last_24_hours: number;
  last_72_hours: number;
  last_7_days: number;
  older: number;
  average_experience: number | null;
  average_pmc_raids: number | null;
  average_scav_raids: number | null;
  average_pmc_kills: number | null;
  average_killed_pmc: number | null;
  average_pmc_survival_rate: number | null;
}

export const SEASONAL_POPULATION_SQL = `SELECT COUNT(*) AS n, MAX(profile_updated_at) AS freshness_at,
  SUM(CASE WHEN profile_updated_at >= ? THEN 1 ELSE 0 END) AS last_24_hours,
  SUM(CASE WHEN profile_updated_at < ? AND profile_updated_at >= ? THEN 1 ELSE 0 END) AS last_72_hours,
  SUM(CASE WHEN profile_updated_at < ? AND profile_updated_at >= ? THEN 1 ELSE 0 END) AS last_7_days,
  SUM(CASE WHEN profile_updated_at < ? THEN 1 ELSE 0 END) AS older,
  AVG(experience) AS average_experience,
  AVG(pmc_raids) AS average_pmc_raids,
  AVG(scav_raids) AS average_scav_raids,
  AVG(pmc_kills) AS average_pmc_kills,
  AVG(killed_pmc) AS average_killed_pmc,
  AVG(CASE WHEN pmc_raids > 0 THEN 100.0 * pmc_survived / pmc_raids END) AS average_pmc_survival_rate
  FROM player_profiles
  WHERE mode = 'seasonal' AND cycle_id = ? AND confirmed_banned = 0
    AND (pmc_raids >= 1 OR scav_raids >= 1)`;

export function seasonalPopulationArgs(cycleId: string, now: number): unknown[] {
  const day = 86_400_000;
  const h24 = now - day;
  const h72 = now - 3 * day;
  const d7 = now - 7 * day;
  return [h24, h24, h72, h72, d7, d7, cycleId];
}

function nullableNumber(value: unknown): number | null {
  return value == null ? null : Number(value);
}

export function seasonalPopulationSummary(
  row: SeasonalPopulationRow | null | undefined,
  lifetimeBandCounts: number[],
): SeasonalPopulationSummary {
  return {
    n: Number(row?.n ?? 0),
    lifetimeBandCounts,
    freshnessAt: row?.freshness_at == null ? null : Number(row.freshness_at),
    freshness: {
      last24Hours: Number(row?.last_24_hours ?? 0),
      last72Hours: Number(row?.last_72_hours ?? 0),
      last7Days: Number(row?.last_7_days ?? 0),
      older: Number(row?.older ?? 0),
    },
    averages: {
      experience: nullableNumber(row?.average_experience),
      pmcRaids: nullableNumber(row?.average_pmc_raids),
      scavRaids: nullableNumber(row?.average_scav_raids),
      pmcKills: nullableNumber(row?.average_pmc_kills),
      killedPmc: nullableNumber(row?.average_killed_pmc),
      pmcSurvivalRate: nullableNumber(row?.average_pmc_survival_rate),
    },
  };
}

export function parseSeasonalAverageRequest(params: URLSearchParams): string | null {
  if ([...params.keys()].some((key) => key !== "cycle") || params.getAll("cycle").length !== 1) return null;
  const cycleId = params.get("cycle")!.trim();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(cycleId) ? cycleId : null;
}

function seasonDay(date: string, startsAt: number): number {
  const start = new Date(startsAt).toLocaleDateString("en-CA", { timeZone: "Europe/Moscow" });
  return Math.floor((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
}

export function progressionDailySql(kind: ProgressionKind): string {
  if (kind === "cumulative") {
    return `
      WITH ranked AS (
        SELECT s.aid, s.local_date, s.experience AS value, s.pmc_raids, s.series_id,
               s.profile_updated_at AS freshness_at, 1.0 AS confidence,
               ROW_NUMBER() OVER (
                 PARTITION BY s.aid, s.local_date
                 ORDER BY s.profile_updated_at DESC, s.id DESC
               ) AS rank
        FROM progression_snapshots s
        WHERE s.mode = 'seasonal' AND s.cycle_id = ?
      )
      SELECT r.aid, r.local_date, r.value,
             CASE WHEN ? = 'hours' THEN p.lifetime_pvp_hours ELSE r.pmc_raids END AS dimension_value,
             p.lifetime_pvp_hours AS lifetime_hours,
             r.freshness_at, r.confidence, r.series_id
      FROM ranked r
      JOIN player_profiles p ON p.mode = 'seasonal' AND p.cycle_id = ? AND p.aid = r.aid
        AND p.confirmed_banned = 0
      WHERE r.rank = 1 AND (p.progression_eligible = 1 OR EXISTS (
        SELECT 1 FROM scan_members m WHERE m.mode = p.mode AND m.cycle_id = p.cycle_id
          AND m.aid = p.aid AND m.active = 1
      ))
      ORDER BY r.local_date, r.aid`;
  }
  const score = kind === "tempo" ? "tempo_score" : "form_score";
  return `
    WITH ranked AS (
      SELECT i.aid, i.local_date, i.${score} AS value, i.ended_at AS freshness_at,
             i.confidence, s.pmc_raids, s.series_id,
             ROW_NUMBER() OVER (
               PARTITION BY i.aid, i.local_date
               ORDER BY i.ended_at DESC, i.id DESC
             ) AS rank
      FROM progression_intervals i
      JOIN progression_snapshots s ON s.id = i.to_snapshot_id
      WHERE i.mode = 'seasonal' AND i.cycle_id = ? AND i.status = 'valid'
        AND i.${score} IS NOT NULL
    )
    SELECT r.aid, r.local_date, r.value,
           CASE WHEN ? = 'hours' THEN p.lifetime_pvp_hours ELSE r.pmc_raids END AS dimension_value,
           p.lifetime_pvp_hours AS lifetime_hours,
           r.freshness_at, r.confidence, r.series_id
    FROM ranked r
    JOIN player_profiles p ON p.mode = 'seasonal' AND p.cycle_id = ? AND p.aid = r.aid
      AND p.confirmed_banned = 0
    WHERE r.rank = 1 AND (p.progression_eligible = 1 OR EXISTS (
      SELECT 1 FROM scan_members m WHERE m.mode = p.mode AND m.cycle_id = p.cycle_id
        AND m.aid = p.aid AND m.active = 1
    ))
    ORDER BY r.local_date, r.aid`;
}

function dailyRows(db: SqliteDatabase, input: Pick<ProgressionRequest, "cycleId" | "kind" | "dimension">): DailyRow[] {
  return db.prepare(progressionDailySql(input.kind))
    .all(input.cycleId, input.dimension, input.cycleId) as DailyRow[];
}

function distributionRows(db: SqliteDatabase, cycleId: string): number[] {
  return lifetimeBandDistribution(
    db.prepare(LIFETIME_BAND_DISTRIBUTION_SQL).all(cycleId) as LifetimeBandCountRow[]
  );
}

export function queryProgressionSeries(db: SqliteDatabase, input: ProgressionRequest): ProgressionSeriesResponse | null {
  const cycle = db.prepare("SELECT starts_at FROM season_cycles WHERE mode = 'seasonal' AND cycle_id = ?").get(input.cycleId) as { starts_at: number } | undefined;
  if (!cycle) return null;
  return buildProgressionSeries(
    dailyRows(db, input),
    Number(cycle.starts_at),
    input,
    distributionRows(db, input.cycleId),
  );
}

function rowBand(hours: number | null): number {
  return LIFETIME_HOUR_BANDS.findIndex(
    ([min, max]) => hours != null && hours >= min && (max == null || hours < max)
  );
}

function progressionPoint(
  date: string,
  value: number,
  values: number[],
  n: number,
  confidence: number,
  cycleStartsAt: number,
  seriesId: number | null,
): ProgressionPoint {
  return {
    date,
    seasonDay: seasonDay(date, cycleStartsAt),
    value,
    seriesId,
    p25: quantile(values, 0.25),
    p75: quantile(values, 0.75),
    n,
    confidence,
  };
}

function overallPoints(
  rows: DailyRow[],
  cycleStartsAt: number,
  distribution: readonly number[],
): ProgressionPoint[] {
  const dates = [...new Set(rows.map((row) => row.local_date))].sort();
  return dates.flatMap((date) => {
    const daily = rows.filter((row) => row.local_date === date);
    const values = daily.map((row) => row.value);
    const byBand = LIFETIME_HOUR_BANDS.map((_, index) =>
      daily.filter((row) => rowBand(row.lifetime_hours) === index).map((row) => row.value)
    );
    const value = weightedEightBandMean(byBand, distribution);
    if (value == null) return [];
    const confidence = daily.reduce((sum, row) => sum + row.confidence, 0) / values.length;
    return [progressionPoint(date, value, values, values.length, confidence, cycleStartsAt, null)];
  });
}

export function buildSeasonalAverageSeries(
  sourceRows: DailyRow[],
  cycleStartsAt: number,
  kind: ProgressionKind,
  distribution: readonly number[],
): SeasonalAverageSeries {
  const rows = sourceRows.filter((row) => Number.isFinite(row.value));
  const overall = overallPoints(rows, cycleStartsAt, distribution);
  const latest = overall.at(-1);
  return {
    kind,
    overall,
    n: latest?.n ?? 0,
    confidence: latest?.confidence ?? 0,
    freshnessAt: rows.length ? Math.max(...rows.map((row) => Number(row.freshness_at))) : null,
  };
}

export function buildProgressionSeries(
  sourceRows: DailyRow[],
  cycleStartsAt: number,
  input: ProgressionRequest,
  distribution: readonly number[],
): ProgressionSeriesResponse {
  const rows = sourceRows.filter((row) => Number.isFinite(row.value));
  const dates = [...new Set(rows.map((row) => row.local_date))].sort();
  let actualRange: ProgressionSeriesResponse["actualRange"] = null;
  let latestN = 0;
  const playerRows = rows.filter((row) => row.aid === input.aid);
  const playerByDate = new Map(playerRows.map((row) => [row.local_date, row]));
  const player = playerRows.map((row) => progressionPoint(
    row.local_date, row.value, [row.value], 1, row.confidence, cycleStartsAt, Number(row.series_id)
  ));
  const nearby = dates.flatMap((date) => {
    const center = input.dimension === "pmc_raids"
      ? playerByDate.get(date)?.dimension_value
      : input.center;
    if (center == null || !Number.isFinite(Number(center))) return [];
    const candidates = rows.filter((row) => row.local_date === date && row.aid !== input.aid && row.dimension_value != null)
      .map((row) => ({ dimensionValue: Number(row.dimension_value), value: row }));
    const cohort = expandNearbyCohort(Number(center), candidates);
    if (!cohort) return [];
    const values = cohort.members.map((member) => member.value.value);
    const value = trimmedMean(values);
    if (value == null) return [];
    actualRange = { min: cohort.min, max: cohort.max };
    latestN = cohort.members.length;
    return [progressionPoint(
      date,
      value,
      values,
      values.length,
      cohort.members.reduce((sum, member) => sum + member.value.confidence, 0) / values.length,
      cycleStartsAt,
      null,
    )];
  });
  const overall = overallPoints(rows, cycleStartsAt, distribution);
  const freshnessAt = rows.length ? Math.max(...rows.map((row) => row.freshness_at)) : null;
  const confidences = nearby.map((entry) => entry.confidence);
  return {
    identity: { mode: "seasonal", cycleId: input.cycleId, aid: input.aid }, kind: input.kind,
    dimension: input.dimension, player, nearby, overall, actualRange, n: latestN,
    confidence: confidences.length ? confidences[confidences.length - 1] : 0, freshnessAt,
  };
}
