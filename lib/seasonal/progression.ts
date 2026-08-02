// @ts-expect-error Node's strip-types test runner requires the extension; Next accepts it.
import { expandNearbyCohort, quantile, SCORE_PRELIMINARY_SAMPLE_N, trimmedMean } from "./analytics.ts";
import type {
  ProgressionKind,
  ProgressionAverageResponse,
  ProgressionPoint,
  ProgressionMode,
  ProgressionSeriesResponse,
  SeasonalAverageSeries,
  SeasonalPopulationSummary,
} from "@/types/seasonal";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SqliteDatabase = any;

export interface ProgressionRequest {
  mode: ProgressionMode;
  cycleId: string;
  aid: number;
  kind: ProgressionKind;
}

export const PROGRESSION_KINDS = ["cumulative", "tempo", "form"] as const satisfies readonly ProgressionKind[];
const KINDS = new Set<ProgressionKind>(PROGRESSION_KINDS);
export const PROGRESSION_BASE_RAID_STEP = 10;
export const PROGRESSION_TARGET_SAMPLE = 200;
export const PROGRESSION_MAX_RAID_WIDTH = 400;
export const PROGRESSION_MIN_SAMPLE = 100;

/** Strict public API validation: required, single-valued parameters only. */
export function parseProgressionRequest(
  params: URLSearchParams,
  legacyMode: ProgressionMode | null = "seasonal",
): ProgressionRequest | null {
  const allowed = new Set(legacyMode ? ["cycle", "aid", "kind"] : ["mode", "cycle", "aid", "kind"]);
  if ([...params.keys()].some((key) => !allowed.has(key))) return null;
  if ([...allowed].some((key) => params.getAll(key).length !== 1)) return null;
  const mode = legacyMode ?? params.get("mode");
  if (mode !== "regular" && mode !== "seasonal") return null;
  const cycle = params.get("cycle")!.trim();
  const cycleId = /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(cycle) ? cycle : null;
  const aidText = params.get("aid")!;
  const aid = Number(aidText);
  const kind = params.get("kind") as ProgressionKind;
  if (!cycleId || !/^[1-9]\d*$/.test(aidText) || !Number.isSafeInteger(aid)) return null;
  if (!KINDS.has(kind)) return null;
  if ((mode === "regular") !== (cycleId === "persistent")) return null;
  return { mode, cycleId, aid, kind };
}

export interface DailyRow {
  aid: number;
  point_id?: number;
  local_date: string;
  observed_at?: number;
  value: number;
  pmc_raids: number;
  raid_bucket: number;
  lifetime_hours: number | null;
  freshness_at: number;
  confidence: number;
  series_id: number;
  score_sample_n?: number | null;
  period_start_at?: number | null;
  elapsed_days?: number | null;
  delta_experience?: number | null;
  delta_pmc_raids?: number | null;
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
  WHERE mode = ? AND cycle_id = ? AND confirmed_banned = 0
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

export function raidBucket(raids: number): number {
  return raids > 0
    ? Math.ceil(raids / PROGRESSION_BASE_RAID_STEP) * PROGRESSION_BASE_RAID_STEP
    : 0;
}

export function progressionDailySql(kind: ProgressionKind): string {
  if (kind === "cumulative") {
    return `
      WITH ranked AS (
        SELECT s.aid, s.id AS point_id, s.local_date, s.profile_updated_at AS observed_at,
               s.experience AS value, s.pmc_raids,
               ((s.pmc_raids - 1) / 10 + 1) * 10 AS raid_bucket, s.series_id,
               s.profile_updated_at AS freshness_at, 1.0 AS confidence, NULL AS score_sample_n,
               NULL AS period_start_at, NULL AS elapsed_days,
               NULL AS delta_experience, NULL AS delta_pmc_raids,
               ROW_NUMBER() OVER (
                 PARTITION BY s.aid, ((s.pmc_raids - 1) / 10 + 1)
                 ORDER BY s.profile_updated_at DESC, s.id DESC
               ) AS rank
        FROM progression_snapshots s
        WHERE s.mode = ? AND s.cycle_id = ? AND s.pmc_raids > 0
      )
      SELECT r.aid, r.point_id, r.local_date, r.observed_at, r.value, r.pmc_raids, r.raid_bucket,
             p.lifetime_pvp_hours AS lifetime_hours,
             r.freshness_at, r.confidence, r.series_id, r.score_sample_n,
             r.period_start_at, r.elapsed_days, r.delta_experience, r.delta_pmc_raids
      FROM ranked r
      JOIN player_profiles p ON p.mode = ? AND p.cycle_id = ? AND p.aid = r.aid
        AND p.confirmed_banned = 0
      WHERE r.rank = 1 OR r.aid = ?
      ORDER BY r.pmc_raids, r.freshness_at, r.aid`;
  }
  const score = kind === "tempo" ? "tempo_score" : "form_score";
  return `
    WITH ranked AS (
      SELECT i.aid, i.id AS point_id, i.local_date, i.ended_at AS observed_at,
             i.${score} AS value, i.ended_at AS freshness_at,
             i.confidence, s.pmc_raids,
             ((s.pmc_raids - 1) / 10 + 1) * 10 AS raid_bucket, s.series_id,
             i.score_sample_n, from_s.profile_updated_at AS period_start_at,
             i.elapsed_days, i.experience AS delta_experience, i.pmc_raids AS delta_pmc_raids,
             ROW_NUMBER() OVER (
               PARTITION BY i.aid, ((s.pmc_raids - 1) / 10 + 1)
               ORDER BY i.ended_at DESC, i.id DESC
             ) AS rank
      FROM progression_intervals i
      JOIN progression_snapshots s ON s.id = i.to_snapshot_id
      JOIN progression_snapshots from_s ON from_s.id = i.from_snapshot_id
      WHERE i.mode = ? AND i.cycle_id = ? AND i.status = 'valid'
        AND i.${score} IS NOT NULL AND i.pmc_raids > 0 AND s.pmc_raids > 0
    )
    SELECT r.aid, r.point_id, r.local_date, r.observed_at, r.value, r.pmc_raids, r.raid_bucket,
           p.lifetime_pvp_hours AS lifetime_hours,
           r.freshness_at, r.confidence, r.series_id, r.score_sample_n,
           r.period_start_at, r.elapsed_days, r.delta_experience, r.delta_pmc_raids
    FROM ranked r
    JOIN player_profiles p ON p.mode = ? AND p.cycle_id = ? AND p.aid = r.aid
      AND p.confirmed_banned = 0
    WHERE r.rank = 1 OR r.aid = ?
    ORDER BY r.pmc_raids, r.freshness_at, r.aid`;
}

function dailyRows(db: SqliteDatabase, input: ProgressionRequest): DailyRow[] {
  const mode = input.mode;
  return db.prepare(progressionDailySql(input.kind))
    .all(mode, input.cycleId, mode, input.cycleId, input.aid) as DailyRow[];
}

export function queryProgressionSeries(db: SqliteDatabase, input: ProgressionRequest): ProgressionSeriesResponse | null {
  const mode = input.mode;
  const cycle = mode === "seasonal"
    ? db.prepare("SELECT starts_at FROM season_cycles WHERE mode = 'seasonal' AND cycle_id = ?").get(input.cycleId) as { starts_at: number } | undefined
    : db.prepare("SELECT MIN(profile_updated_at) AS starts_at FROM progression_snapshots WHERE mode = ? AND cycle_id = ?")
      .get(mode, input.cycleId) as { starts_at: number | null } | undefined;
  if (!cycle?.starts_at) return null;
  return buildProgressionSeries(
    dailyRows(db, input),
    input,
  );
}

export function queryProgressionSeriesBundle(
  db: SqliteDatabase,
  identity: Omit<ProgressionRequest, "kind">,
): Record<ProgressionKind, ProgressionSeriesResponse> | null {
  const cycle = identity.mode === "seasonal"
    ? db.prepare("SELECT starts_at FROM season_cycles WHERE mode = 'seasonal' AND cycle_id = ?")
      .get(identity.cycleId) as { starts_at: number } | undefined
    : db.prepare("SELECT MIN(profile_updated_at) AS starts_at FROM progression_snapshots WHERE mode = ? AND cycle_id = ?")
      .get(identity.mode, identity.cycleId) as { starts_at: number | null } | undefined;
  if (!cycle?.starts_at) return null;
  return Object.fromEntries(PROGRESSION_KINDS.map((kind) => {
    const input = { ...identity, kind };
    return [kind, buildProgressionSeries(dailyRows(db, input), input)];
  })) as Record<ProgressionKind, ProgressionSeriesResponse>;
}

function latestPerAid(rows: DailyRow[]): DailyRow[] {
  const latest = new Map<number, DailyRow>();
  for (const row of rows) {
    const current = latest.get(row.aid);
    if (!current || row.freshness_at > current.freshness_at) latest.set(row.aid, row);
  }
  return [...latest.values()];
}

function sampleConfidence(rows: DailyRow[]): number {
  if (!rows.length) return 0;
  const source = rows.reduce((sum, row) => sum + row.confidence, 0) / rows.length;
  return source * Math.min(1, rows.length / 30);
}

function pointConfidence(row: DailyRow): number {
  const sampleN = row.score_sample_n;
  return Number(row.confidence) * (sampleN == null ? 1 : Math.min(1, Math.max(0, Number(sampleN)) / 30));
}

function fallbackPointId(prefix: string, row: DailyRow): string {
  return `${prefix}:${row.point_id ?? `${row.series_id}:${row.pmc_raids}:${row.freshness_at}`}`;
}

function progressionPoint({
  pointId,
  date,
  observedAt,
  pmcRaids,
  value,
  values,
  n,
  confidence,
  seriesId,
  sampleN,
  raidRange,
  interval,
}: {
  pointId: string;
  date: string;
  observedAt: number | null;
  pmcRaids: number;
  value: number;
  values: number[];
  n: number;
  confidence: number;
  seriesId: number | null;
  sampleN: number | null;
  raidRange?: { min: number; max: number };
  interval?: DailyRow;
}): ProgressionPoint {
  return {
    pointId,
    date,
    observedAt,
    pmcRaids,
    ...(raidRange ? { raidMin: raidRange.min, raidMax: raidRange.max } : {}),
    ...(interval ? {
      periodStartAt: interval.period_start_at ?? null,
      elapsedDays: interval.elapsed_days ?? null,
      deltaExperience: interval.delta_experience ?? null,
      deltaPmcRaids: interval.delta_pmc_raids ?? null,
    } : {}),
    value,
    seriesId,
    p25: quantile(values, 0.25),
    p75: quantile(values, 0.75),
    n,
    sampleN,
    preliminary: sampleN != null && sampleN < SCORE_PRELIMINARY_SAMPLE_N,
    confidence,
  };
}

function overallPoints(
  rows: DailyRow[],
  scored = false,
): ProgressionPoint[] {
  const rowsByBucket = new Map<number, DailyRow[]>();
  for (const row of rows) {
    if (row.raid_bucket <= 0) continue;
    const bucketRows = rowsByBucket.get(row.raid_bucket) ?? [];
    bucketRows.push(row);
    rowsByBucket.set(row.raid_bucket, bucketRows);
  }
  const buckets = [...rowsByBucket.keys()].sort((a, b) => a - b);
  const points: ProgressionPoint[] = [];
  let bucketIndex = 0;
  while (bucketIndex < buckets.length) {
    const start = buckets[bucketIndex];
    let end = start;
    let members: DailyRow[] = [];
    do {
      members = latestPerAid([...members, ...(rowsByBucket.get(end) ?? [])]);
      if (members.length >= PROGRESSION_TARGET_SAMPLE ||
        end - start + PROGRESSION_BASE_RAID_STEP >= PROGRESSION_MAX_RAID_WIDTH) break;
      end += PROGRESSION_BASE_RAID_STEP;
    } while (true);
    bucketIndex = buckets.findIndex((bucket) => bucket > end);
    if (bucketIndex === -1) bucketIndex = buckets.length;
    if (members.length < PROGRESSION_MIN_SAMPLE) continue;
    const values = members.map((row) => row.value);
    const value = quantile(values, 0.5);
    if (value == null) continue;
    const confidence = members.reduce((sum, row) => sum + row.confidence, 0) / members.length
      * Math.min(1, members.length / (scored ? SCORE_PRELIMINARY_SAMPLE_N : PROGRESSION_TARGET_SAMPLE));
    const latest = members.reduce((current, row) => row.freshness_at > current.freshness_at ? row : current);
    points.push(progressionPoint({
      pointId: fallbackPointId("overall", latest),
      date: latest.local_date,
      observedAt: latest.observed_at ?? latest.freshness_at,
      pmcRaids: end,
      value,
      values,
      n: values.length,
      confidence,
      seriesId: null,
      sampleN: scored ? values.length : null,
      raidRange: { min: start - PROGRESSION_BASE_RAID_STEP + 1, max: end },
    }));
  }
  return points;
}

export function buildSeasonalAverageSeries(
  sourceRows: DailyRow[],
  _cycleStartsAt: number,
  kind: ProgressionKind,
  _distribution: readonly number[],
): SeasonalAverageSeries {
  void _distribution;
  const rows = sourceRows.filter((row) => Number.isFinite(row.value));
  const overall = overallPoints(rows, kind !== "cumulative");
  const latest = overall.at(-1);
  return {
    kind,
    overall,
    n: latest?.n ?? 0,
    confidence: latest?.confidence ?? 0,
    freshnessAt: rows.length ? Math.max(...rows.map((row) => Number(row.freshness_at))) : null,
  };
}

export function queryRegularProgressionAverage(db: SqliteDatabase): ProgressionAverageResponse {
  const mode = "regular";
  const cycleId = "persistent";
  const kinds = ["cumulative", "tempo", "form"] as const satisfies readonly ProgressionKind[];
  const series = Object.fromEntries(kinds.map((kind) => [
    kind,
    buildSeasonalAverageSeries(
      db.prepare(progressionDailySql(kind)).all(mode, cycleId, mode, cycleId, -1) as DailyRow[],
      0,
      kind,
      [],
    ),
  ])) as ProgressionAverageResponse["series"];
  return { mode, cycleId, axis: "pmc_raids", series };
}

export function buildProgressionSeries(
  sourceRows: DailyRow[],
  input: ProgressionRequest,
): ProgressionSeriesResponse {
  const rows = sourceRows.filter((row) => Number.isFinite(row.value));
  let latestN = 0;
  const playerRowsByCoordinate = new Map<string, DailyRow>();
  for (const row of rows.filter((candidate) => candidate.aid === input.aid)) {
    const key = `${row.series_id}:${row.pmc_raids}`;
    const current = playerRowsByCoordinate.get(key);
    if (!current || row.freshness_at > current.freshness_at ||
      (row.freshness_at === current.freshness_at && Number(row.point_id ?? 0) > Number(current.point_id ?? 0))) {
      playerRowsByCoordinate.set(key, row);
    }
  }
  const playerRows = [...playerRowsByCoordinate.values()].sort((left, right) =>
    left.series_id - right.series_id || left.freshness_at - right.freshness_at
  );
  const player = playerRows.map((row) => progressionPoint({
    pointId: fallbackPointId(`${input.kind}:player`, row),
    date: row.local_date,
    observedAt: row.observed_at ?? row.freshness_at,
    pmcRaids: row.pmc_raids,
    value: row.value,
    values: [],
    n: 1,
    confidence: input.kind === "cumulative" ? row.confidence : pointConfidence(row),
    seriesId: Number(row.series_id),
    sampleN: input.kind === "cumulative" ? null : (row.score_sample_n ?? null),
    interval: input.kind === "cumulative" ? undefined : row,
  }));
  const playerHours = playerRows.find((row) => row.lifetime_hours != null)?.lifetime_hours;
  const buckets = [...new Set(playerRows.map((row) => row.raid_bucket))].sort((a, b) => a - b);
  const nearby = playerHours == null ? [] : buckets.flatMap((bucket) => {
    const candidates = latestPerAid(rows.filter((row) =>
      row.raid_bucket === bucket && row.aid !== input.aid && row.lifetime_hours != null
    )).map((row) => ({ dimensionValue: Number(row.lifetime_hours), value: row }));
    if (!candidates.length) return [];
    const cohort = expandNearbyCohort(Number(playerHours), candidates)
      ?? expandNearbyCohort(Number(playerHours), candidates, 1);
    if (!cohort) return [];
    const values = cohort.members.map((member) => member.value.value);
    const value = trimmedMean(values);
    if (value == null) return [];
    latestN = cohort.members.length;
    const members = cohort.members.map((member) => member.value);
    const latest = members.reduce((current, row) => row.freshness_at > current.freshness_at ? row : current);
    return [progressionPoint({
      pointId: fallbackPointId(`nearby:${bucket}`, latest),
      date: latest.local_date,
      observedAt: latest.observed_at ?? latest.freshness_at,
      pmcRaids: bucket,
      value,
      values,
      n: values.length,
      confidence: sampleConfidence(members),
      seriesId: null,
    sampleN: input.kind === "cumulative" ? null : values.length,
      raidRange: { min: bucket - PROGRESSION_BASE_RAID_STEP + 1, max: bucket },
    })];
  });
  const overall = overallPoints(rows, input.kind !== "cumulative");
  const freshnessAt = rows.length ? Math.max(...rows.map((row) => row.freshness_at)) : null;
  const confidences = nearby.map((entry) => entry.confidence);
  const firstObservedAt = playerRows.length ? Math.min(...playerRows.map((row) => Number(row.freshness_at))) : null;
  const lastObservedAt = playerRows.length ? Math.max(...playerRows.map((row) => Number(row.freshness_at))) : null;
  return {
    identity: { mode: input.mode, cycleId: input.cycleId, aid: input.aid }, kind: input.kind,
    axis: "pmc_raids", player, nearby, overall, n: latestN,
    confidence: confidences.length ? confidences[confidences.length - 1] : 0, freshnessAt,
    history: {
      snapshotCount: 0,
      allIntervalCount: 0,
      changedIntervalCount: 0,
      raidIntervalCount: 0,
      tempoPointCount: 0,
      formPointCount: 0,
      intervalCount: 0,
      ready: false,
      firstObservedAt,
      lastObservedAt,
    },
  };
}
