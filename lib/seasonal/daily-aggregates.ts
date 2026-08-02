// @ts-expect-error Node's strip-types test runner requires the extension; Next accepts it.
import { ANALYTICS_SCORE_VERSION, formScore, isRaidProgressionInterval, percentileRank, quantile, tempoScore, trimmedMean } from "./analytics.ts";
// @ts-expect-error Node's strip-types test runner requires the extension; Next accepts it.
import { d1Rows, getSeasonalD1, type D1DatabaseLike } from "./d1.ts";
// @ts-expect-error Node's strip-types test runner requires the extension; Next accepts it.
import { initializeSeasonalSchema } from "./storage.ts";
// @ts-expect-error Node's strip-types test runner requires the extension; Next accepts it.
import { type DailyAggregateRecord, type ProgressionKind, type ProgressionMode } from "../../types/seasonal.ts";
// @ts-expect-error Node's strip-types test runner requires the extension; Next accepts it.
import { raidBucket } from "./progression.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SqliteDatabase = any;

interface IntervalRow extends Record<string, unknown> {
  id: number; aid: number; local_date: string; ended_at: number; elapsed_days: number;
  status?: string;
  experience: number; pmc_raids: number; scav_raids: number; pmc_survived: number; pmc_deaths: number;
  pmc_kills: number; killed_pmc: number; confidence: number; score_sample_n: number | null;
  lifetime_pvp_hours: number | null; dimension_raids: number;
}

interface AggregatePoint {
  aid: number; date: string; value: number; hours: number | null; raids: number;
  confidence: number; freshnessAt: number;
}

interface ScoreUpdate { id: number; tempo: number | null; form: number | null; sampleN: number | null }

function divide(value: number, denominator: number): number {
  return denominator === 0 ? value : value / denominator;
}

function intervalMetrics(row: IntervalRow) {
  const days = Number(row.elapsed_days);
  const raids = Number(row.pmc_raids);
  const deaths = Number(row.pmc_deaths);
  const nonPmc = Number(row.pmc_kills) - Number(row.killed_pmc);
  return {
    xpDay: Number(row.experience) / days,
    raidsDay: raids / days,
    pvpDay: Number(row.killed_pmc) / days,
    nonPmcDay: nonPmc / days,
    survival: raids > 0 ? Number(row.pmc_survived) / raids : 0,
    pvpKd: divide(Number(row.killed_pmc), deaths),
    aiKd: divide(nonPmc, deaths),
    pvpRaid: raids > 0 ? Number(row.killed_pmc) / raids : 0,
    nonPmcRaid: raids > 0 ? nonPmc / raids : 0,
  };
}

export function scoreIntervals(rows: IntervalRow[]): ScoreUpdate[] {
  const byBucket = new Map<number, IntervalRow[]>();
  for (const row of rows) {
    const bucket = raidBucket(Number(row.dimension_raids));
    const values = byBucket.get(bucket) ?? [];
    values.push(row);
    byBucket.set(bucket, values);
  }
  const updates: ScoreUpdate[] = [];
  for (const rowsInBucket of byBucket.values()) {
    const latest = new Map<number, IntervalRow>();
    for (const row of rowsInBucket) {
      if (!isRaidProgressionInterval(row.status ?? "valid", Number(row.pmc_raids))) continue;
      const current = latest.get(Number(row.aid));
      if (!current || Number(row.ended_at) > Number(current.ended_at) ||
        (Number(row.ended_at) === Number(current.ended_at) && Number(row.id) > Number(current.id))) {
        latest.set(Number(row.aid), row);
      }
    }
    const population = [...latest.values()].filter((row) =>
      isRaidProgressionInterval(row.status ?? "valid", Number(row.pmc_raids)));
    const sampleN = population.length;
    const tempoPopulation = population.map(intervalMetrics);
    const formPopulation = population.map(intervalMetrics);
    for (const row of rowsInBucket) {
      const metric = intervalMetrics(row);
      const rank = (value: number, values: number[]) => percentileRank(value, values) ?? 50;
      const scoreable = isRaidProgressionInterval(row.status ?? "valid", Number(row.pmc_raids));
      const tempo = scoreable ? tempoScore({
        xpPerDay: rank(metric.xpDay, tempoPopulation.map((entry) => entry.xpDay)),
        pmcRaidsPerDay: rank(metric.raidsDay, tempoPopulation.map((entry) => entry.raidsDay)),
        killedPmcPerDay: rank(metric.pvpDay, tempoPopulation.map((entry) => entry.pvpDay)),
        nonPmcKillsPerDay: rank(metric.nonPmcDay, tempoPopulation.map((entry) => entry.nonPmcDay)),
      }) : null;
      const form = scoreable ? formScore({
        survivalRate: rank(metric.survival, formPopulation.map((entry) => entry.survival)),
        pvpKd: rank(metric.pvpKd, formPopulation.map((entry) => entry.pvpKd)),
        aiScavKd: rank(metric.aiKd, formPopulation.map((entry) => entry.aiKd)),
        killedPmcPerRaid: rank(metric.pvpRaid, formPopulation.map((entry) => entry.pvpRaid)),
        nonPmcKillsPerRaid: rank(metric.nonPmcRaid, formPopulation.map((entry) => entry.nonPmcRaid)),
      }) : null;
      updates.push({ id: Number(row.id), tempo, form, sampleN: scoreable ? sampleN : null });
    }
  }
  return updates;
}

function latestPoints(rows: IntervalRow[], updates: ScoreUpdate[], kind: "tempo" | "form"): AggregatePoint[] {
  const scores = new Map(updates.map((update) => [update.id, kind === "tempo" ? update.tempo : update.form]));
  const latest = new Map<string, IntervalRow>();
  for (const row of rows) {
    if (scores.get(Number(row.id)) == null) continue;
    const key = `${row.aid}:${raidBucket(Number(row.dimension_raids))}`;
    const current = latest.get(key);
    if (!current || Number(row.ended_at) > Number(current.ended_at) ||
      (Number(row.ended_at) === Number(current.ended_at) && Number(row.id) > Number(current.id))) latest.set(key, row);
  }
  return [...latest.values()].map((row) => ({
    aid: Number(row.aid), date: String(row.local_date), value: Number(scores.get(Number(row.id))),
    hours: row.lifetime_pvp_hours == null ? null : Number(row.lifetime_pvp_hours),
    raids: Number(row.dimension_raids), confidence: Number(row.confidence), freshnessAt: Number(row.ended_at),
  }));
}

function aggregateGroup(mode: ProgressionMode, cycleId: string, kind: ProgressionKind, bucket: number,
  points: AggregatePoint[]): DailyAggregateRecord | null {
  if (!points.length) return null;
  const values = points.map((point) => point.value);
  const mean = trimmedMean(values);
  if (mean == null) return null;
  return {
    mode, cycleId, localDate: points.reduce((latest, point) => point.date > latest ? point.date : latest, points[0].date),
    kind, dimension: "pmc_raids",
    bucketMin: bucket - 10, bucketMax: bucket, mean, p25: quantile(values, 0.25), p75: quantile(values, 0.75),
    n: points.length, confidence: points.reduce((sum, point) => sum + point.confidence, 0) / points.length
      * Math.min(1, points.length / 30),
    freshnessAt: Math.max(...points.map((point) => point.freshnessAt)), scoreVersion: 1,
  };
}

export function materializeRows(cycleId: string, pointsByKind: Record<ProgressionKind, AggregatePoint[]>, mode: ProgressionMode = "seasonal"): DailyAggregateRecord[] {
  const output: DailyAggregateRecord[] = [];
  for (const kind of ["cumulative", "tempo", "form"] as const) {
    const buckets = new Map<number, AggregatePoint[]>();
    for (const point of pointsByKind[kind]) {
      const bucket = raidBucket(point.raids);
      if (bucket > 0) buckets.set(bucket, [...(buckets.get(bucket) ?? []), point]);
    }
    for (const [bucket, members] of buckets) {
      const latest = new Map<number, AggregatePoint>();
      for (const point of members) {
        const current = latest.get(point.aid);
        if (!current || point.freshnessAt > current.freshnessAt) latest.set(point.aid, point);
      }
      const row = aggregateGroup(mode, cycleId, kind, bucket, [...latest.values()]);
      if (row) output.push(row);
    }
  }
  return output;
}

function intervalSql(targetBucket?: number): string {
  return `SELECT i.*, p.lifetime_pvp_hours, s.pmc_raids AS dimension_raids
    FROM progression_intervals i JOIN player_profiles p
      ON p.mode = i.mode AND p.cycle_id = i.cycle_id AND p.aid = i.aid AND p.confirmed_banned = 0
    JOIN progression_snapshots s ON s.id = i.to_snapshot_id
    WHERE i.mode = ? AND i.cycle_id = ? AND i.status = 'valid'
      ${targetBucket == null ? "" : "AND ((s.pmc_raids - 1) / 10 + 1) * 10 = ?"}
    ORDER BY s.pmc_raids, i.aid, i.ended_at, i.id`;
}

function cumulativeSql(targetBucket?: number): string {
  return `WITH ranked AS (
      SELECT s.*, ROW_NUMBER() OVER (
        PARTITION BY s.aid, ((s.pmc_raids - 1) / 10 + 1)
        ORDER BY s.profile_updated_at DESC, s.id DESC
      ) rank
      FROM progression_snapshots s WHERE s.mode = ? AND s.cycle_id = ? AND s.pmc_raids > 0
    ) SELECT r.aid, r.local_date, r.experience AS value, r.pmc_raids AS dimension_raids,
      r.profile_updated_at AS freshness_at, p.lifetime_pvp_hours
    FROM ranked r JOIN player_profiles p ON p.mode = ? AND p.cycle_id = ? AND p.aid = r.aid
      AND p.confirmed_banned = 0 WHERE r.rank = 1
      ${targetBucket == null ? "" : "AND ((r.pmc_raids - 1) / 10 + 1) * 10 = ?"}
    ORDER BY r.pmc_raids, r.aid`;
}

function cumulativePoints(rows: Record<string, unknown>[]): AggregatePoint[] {
  return rows.map((row) => ({ aid: Number(row.aid), date: String(row.local_date), value: Number(row.value),
    hours: row.lifetime_pvp_hours == null ? null : Number(row.lifetime_pvp_hours), raids: Number(row.dimension_raids),
    confidence: 1, freshnessAt: Number(row.freshness_at) }));
}

export function refreshSqliteProgressionAggregates(
  db: SqliteDatabase,
  mode: ProgressionMode,
  cycleId: string,
  targetBucket?: number,
): { intervals: number; aggregates: number; generation: number } {
  initializeSeasonalSchema(db);
  const intervalArgs = targetBucket == null ? [mode, cycleId] : [mode, cycleId, targetBucket];
  const cumulativeArgs = targetBucket == null ? [mode, cycleId, mode, cycleId] : [mode, cycleId, mode, cycleId, targetBucket];
  const intervals = db.prepare(intervalSql(targetBucket)).all(...intervalArgs) as IntervalRow[];
  const cumulative = cumulativePoints(db.prepare(cumulativeSql(targetBucket)).all(...cumulativeArgs) as Record<string, unknown>[]);
  const updates = scoreIntervals(intervals);
  const aggregates = materializeRows(cycleId, {
    cumulative, tempo: latestPoints(intervals, updates, "tempo"), form: latestPoints(intervals, updates, "form"),
  }, mode);
  db.exec("SAVEPOINT refresh_progression_aggregates");
  try {
    if (targetBucket == null) {
      db.prepare(`UPDATE progression_intervals SET tempo_score = NULL, form_score = NULL,
        score_sample_n = NULL WHERE mode = ? AND cycle_id = ?`).run(mode, cycleId);
    } else {
      db.prepare(`UPDATE progression_intervals SET tempo_score = NULL, form_score = NULL,
        score_sample_n = NULL WHERE mode = ? AND cycle_id = ? AND to_snapshot_id IN (
          SELECT s.id FROM progression_snapshots s
          WHERE s.mode = ? AND s.cycle_id = ? AND ((s.pmc_raids - 1) / 10 + 1) * 10 = ?
        )`).run(mode, cycleId, mode, cycleId, targetBucket);
    }
    const update = db.prepare("UPDATE progression_intervals SET tempo_score = ?, form_score = ?, score_sample_n = ?, score_version = ? WHERE id = ?");
    for (const item of updates) update.run(item.tempo, item.form, item.sampleN, ANALYTICS_SCORE_VERSION, item.id);
    if (targetBucket == null) {
      db.prepare("DELETE FROM daily_aggregates WHERE mode = ? AND cycle_id = ?").run(mode, cycleId);
    } else {
      db.prepare("DELETE FROM daily_aggregates WHERE mode = ? AND cycle_id = ? AND bucket_min = ?")
        .run(mode, cycleId, targetBucket - 10);
    }
    const insert = db.prepare(`INSERT INTO daily_aggregates (mode, cycle_id, local_date, kind, dimension,
      bucket_min, bucket_max, mean, p25, p75, n, confidence, freshness_at, score_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of aggregates) insert.run(row.mode, row.cycleId, row.localDate, row.kind, row.dimension, row.bucketMin,
      row.bucketMax, row.mean, row.p25, row.p75, row.n, row.confidence, row.freshnessAt, row.scoreVersion);
    const generation = Number((db.prepare(`INSERT INTO progression_materializations
      (mode, cycle_id, generation, materialized_at, score_version)
      VALUES (?, ?, COALESCE((SELECT generation + 1 FROM progression_materializations WHERE mode = ? AND cycle_id = ?), 1), ?, ?)
      ON CONFLICT(mode, cycle_id) DO UPDATE SET generation = progression_materializations.generation + 1,
        materialized_at = excluded.materialized_at, score_version = excluded.score_version
      RETURNING generation`).get(mode, cycleId, mode, cycleId, Date.now(), ANALYTICS_SCORE_VERSION) as { generation: number }).generation);
    db.exec("RELEASE refresh_progression_aggregates");
    return { intervals: updates.length, aggregates: aggregates.length, generation };
  } catch (error) {
    db.exec("ROLLBACK TO refresh_progression_aggregates");
    db.exec("RELEASE refresh_progression_aggregates");
    throw error;
  }
}

export function refreshSqliteSeasonalAggregates(db: SqliteDatabase, cycleId: string, targetBucket?: number) {
  return refreshSqliteProgressionAggregates(db, "seasonal", cycleId, targetBucket);
}

async function chunkedBatch(db: D1DatabaseLike, statements: unknown[], size = 250): Promise<void> {
  for (let index = 0; index < statements.length; index += size) await db.batch(statements.slice(index, index + size));
}

export async function refreshD1SeasonalAggregates(
  db: D1DatabaseLike,
  cycleId: string,
  targetBucket?: number,
): Promise<{ intervals: number; aggregates: number; generation: number }> {
  const intervalStatement = db.prepare(intervalSql(targetBucket));
  const cumulativeStatement = db.prepare(cumulativeSql(targetBucket));
  const [intervalResult, cumulativeResult] = await db.batch([
    targetBucket == null
      ? intervalStatement.bind("seasonal", cycleId)
      : intervalStatement.bind("seasonal", cycleId, targetBucket),
    targetBucket == null
      ? cumulativeStatement.bind("seasonal", cycleId, "seasonal", cycleId)
      : cumulativeStatement.bind("seasonal", cycleId, "seasonal", cycleId, targetBucket),
  ]);
  const intervals = d1Rows(intervalResult) as unknown as IntervalRow[];
  const cumulative = cumulativePoints(d1Rows(cumulativeResult));
  const updates = scoreIntervals(intervals);
  const aggregates = materializeRows(cycleId, {
    cumulative, tempo: latestPoints(intervals, updates, "tempo"), form: latestPoints(intervals, updates, "form"),
  });
  await db.prepare(`UPDATE progression_intervals SET tempo_score = NULL, form_score = NULL,
    score_sample_n = NULL WHERE mode = 'seasonal' AND cycle_id = ?${targetBucket == null ? "" : ` AND to_snapshot_id IN (
      SELECT s.id FROM progression_snapshots s WHERE s.mode = 'seasonal' AND s.cycle_id = ?
        AND ((s.pmc_raids - 1) / 10 + 1) * 10 = ?
    )`}`).bind(...(targetBucket == null ? [cycleId] : [cycleId, cycleId, targetBucket])).run();
  await chunkedBatch(db, updates.map((item) => db.prepare(
    "UPDATE progression_intervals SET tempo_score = ?, form_score = ?, score_sample_n = ?, score_version = ? WHERE id = ?"
  ).bind(item.tempo, item.form, item.sampleN, ANALYTICS_SCORE_VERSION, item.id)));
  if (targetBucket == null) {
    await db.prepare("DELETE FROM daily_aggregates WHERE mode = 'seasonal' AND cycle_id = ?").bind(cycleId).run();
  } else {
    await db.prepare("DELETE FROM daily_aggregates WHERE mode = 'seasonal' AND cycle_id = ? AND bucket_min = ?")
      .bind(cycleId, targetBucket - 10).run();
  }
  await chunkedBatch(db, aggregates.map((row) => db.prepare(`INSERT INTO daily_aggregates (
    mode, cycle_id, local_date, kind, dimension, bucket_min, bucket_max, mean, p25, p75, n,
    confidence, freshness_at, score_version) VALUES ('seasonal', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(row.cycleId, row.localDate, row.kind, row.dimension, row.bucketMin, row.bucketMax,
        row.mean, row.p25, row.p75, row.n, row.confidence, row.freshnessAt, row.scoreVersion)));
  const generationRow = await db.prepare(`INSERT INTO progression_materializations
    (mode, cycle_id, generation, materialized_at, score_version)
    VALUES ('seasonal', ?, COALESCE((SELECT generation + 1 FROM progression_materializations WHERE mode = 'seasonal' AND cycle_id = ?), 1), ?, ?)
    ON CONFLICT(mode, cycle_id) DO UPDATE SET generation = progression_materializations.generation + 1,
      materialized_at = excluded.materialized_at, score_version = excluded.score_version
    RETURNING generation`).bind(cycleId, cycleId, Date.now(), ANALYTICS_SCORE_VERSION).first() as { generation: number } | null;
  return { intervals: updates.length, aggregates: aggregates.length, generation: Number(generationRow?.generation ?? 0) };
}

export async function refreshSeasonalDailyAggregates(cycleId: string, targetBucket?: number) {
  const d1 = await getSeasonalD1();
  if (d1) return refreshD1SeasonalAggregates(d1, cycleId, targetBucket);
  const sqlite = (await import("node:sqlite" as string)) as { DatabaseSync: new (path: string) => SqliteDatabase };
  const db = new sqlite.DatabaseSync(process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db");
  try { return refreshSqliteSeasonalAggregates(db, cycleId, targetBucket); } finally { db.close(); }
}

export async function refreshProgressionAfterCapture(
  mode: ProgressionMode,
  cycleId: string,
  pmcRaids: number,
) {
  const bucket = raidBucket(pmcRaids);
  if (bucket <= 0) return { intervals: 0, aggregates: 0, generation: 0 };
  if (mode === "seasonal") return refreshSeasonalDailyAggregates(cycleId, bucket);
  const sqlite = (await import("node:sqlite" as string)) as { DatabaseSync: new (path: string) => SqliteDatabase };
  const db = new sqlite.DatabaseSync(process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db");
  try { return refreshSqliteProgressionAggregates(db, mode, cycleId, bucket); } finally { db.close(); }
}
