import {
  buildProgressionPopulationMetric, progressionDailySql, PROGRESSION_KINDS,
  LIFETIME_BAND_DISTRIBUTION_SQL, lifetimeBandDistribution, SEASONAL_POPULATION_SQL,
  seasonalPopulationArgs, seasonalPopulationSummary,
  type DailyRow, type LifetimeBandCountRow, type SeasonalPopulationRow,
} from "./progression.ts";
import type { ProgressionAverageResponse, ProgressionMode, SeasonalAverageResponse } from "../../types/seasonal";
import { readStatisticsResponse } from "../average-publication.ts";

type Average = ProgressionAverageResponse | SeasonalAverageResponse;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Database = any;
export const PROGRESSION_AVERAGE_REFRESH_MS = 6 * 60 * 60_000;

/** Only the scheduled publisher calls this; retain one adaptive raid window at a time. */
export function buildPublishedProgressionAverage(db: Database, mode: ProgressionMode, cycleId: string, now: number): Average | null {
  if (mode === "seasonal" && !db.prepare(
    "SELECT 1 FROM season_cycles WHERE mode = 'seasonal' AND cycle_id = ?",
  ).get(cycleId)) return null;
  const series = Object.fromEntries(PROGRESSION_KINDS.map(kind => {
    const rows = db.prepare(progressionDailySql(kind)).iterate(mode, cycleId, mode, cycleId, -1) as Iterable<DailyRow>;
    const result = buildProgressionPopulationMetric(rows, kind === "cumulative" ? "xp" : "xp_per_day", [], `${kind}:overall`);
    const latest = result.overall.at(-1);
    return [kind, { kind, overall: result.overall, n: latest?.n ?? 0,
      confidence: latest?.confidence ?? 0, freshnessAt: result.freshnessAt }];
  })) as Average["series"];
  if (mode !== "seasonal") return { mode, cycleId, axis: "pmc_raids", series };
  const population = db.prepare(SEASONAL_POPULATION_SQL)
    .get(...seasonalPopulationArgs(cycleId, now)) as SeasonalPopulationRow | undefined;
  const distribution = lifetimeBandDistribution(
    db.prepare(LIFETIME_BAND_DISTRIBUTION_SQL).all(mode, cycleId) as LifetimeBandCountRow[],
  );
  return { mode, cycleId, population: seasonalPopulationSummary(population, distribution), series };
}

export function readPublishedProgressionAverage(db: Database, mode: ProgressionMode, cycleId: string, now = Date.now()) {
  // Project the small response in SQLite instead of parsing the entire risk/timeline population in HTTP.
  const row = db.prepare(`SELECT g.generated_at, json_extract(g.payload, '$.average') AS average
    FROM progression_population_current c JOIN progression_population_generations g
      ON g.mode = c.mode AND g.cycle_id = c.cycle_id AND g.generation = c.generation
    WHERE c.mode = ? AND c.cycle_id = ?`).get(mode, cycleId);
  if (!row?.average) return null;
  const value = JSON.parse(String(row.average)) as Average;
  if (value.mode !== mode || value.cycleId !== cycleId || !value.series) return null;
  const generatedAt = Number(row.generated_at);
  return { value, generatedAt, stale: now - generatedAt >= PROGRESSION_AVERAGE_REFRESH_MS };
}

/** Public reads never initialize schemas, scan histories, or enqueue computation. */
export async function getPublishedProgressionAverage(mode: ProgressionMode, cycleId: string) {
  let db: Database;
  try {
    const sqlite = await import("node:sqlite" as string);
    db = new sqlite.DatabaseSync(process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db", { readOnly: true });
    db.exec("PRAGMA busy_timeout = 100");
    const published = readPublishedProgressionAverage(db, mode, cycleId);
    if (published) return published;
  } catch (error) {
    console.warn("published progression average unavailable: " + (error as Error).message);
  } finally {
    db?.close();
  }
  // Preserve the previous release's durable successful answer until the first new publication.
  const key = mode === "seasonal" ? JSON.stringify(["average-progression-seasonal-v2", cycleId])
    : mode === "pve" ? "average-progression-pve-v1" : "average-progression-regular-v2";
  const saved = await readStatisticsResponse<{ value: Average; generatedAt: number }>(`statistics-v1:${key}`);
  if (!saved?.value || saved.value.mode !== mode || saved.value.cycleId !== cycleId || !saved.value.series) return null;
  return { value: saved.value, generatedAt: saved.generatedAt, stale: true };
}
