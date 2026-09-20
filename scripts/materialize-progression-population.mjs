import { DatabaseSync } from "node:sqlite";
import { materializeRegularProgression } from "../lib/regular-progression.ts";
import { refreshSqliteProgressionAggregates } from "../lib/seasonal/daily-aggregates.ts";
import {
  materializeSqlitePopulationSnapshot,
} from "../lib/seasonal/progression-db.ts";
import { initializeSeasonalSchema } from "../lib/seasonal/storage.ts";
import {
  materializeAchievementBaseline,
} from "../lib/achievement-baseline-publication.ts";

const intervalMs = 21_600_000;
export const retryIntervalMs = 15 * 60_000;
const configuredInitialDelayMs = Number(process.env.PROGRESSION_MATERIALIZE_INITIAL_DELAY_MS);
const initialDelayMs = Number.isFinite(configuredInitialDelayMs) && configuredInitialDelayMs >= 0
  ? configuredInitialDelayMs
  : 300_000;
const databasePath = process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db";
const playersDatabasePath = process.env.SQLITE_PATH || "/data/players.db";
let running = false;

function materializeAchievementBaselines(reason) {
  const startedAt = Date.now();
  const db = new DatabaseSync(playersDatabasePath);
  try {
    const published = [
      materializeAchievementBaseline(db, "regular"),
      materializeAchievementBaseline(db, "pve"),
    ].map(({ mode, generation, generatedAt, total, achievements }) => ({
      mode, generation, generatedAt, total, achievements: achievements.length,
    }));
    console.log(`achievement baselines materialized (${reason}) in ${Date.now() - startedAt}ms`, published);
    return { skipped: false, published };
  } catch (error) {
    console.warn(`achievement baseline materialization failed (${reason}): ${error instanceof Error ? error.message : String(error)}`);
    return { skipped: false, error };
  } finally {
    db.close();
  }
}

export function materializeDuePopulations(db, scopes, { now = Date.now(), refresh, publish = materializeSqlitePopulationSnapshot } = {}) {
  const published = [];
  const errors = [];
  for (const { mode, cycleId } of scopes) {
    const current = db.prepare(`SELECT generated_at FROM progression_population_current
      WHERE mode = ? AND cycle_id = ?`).get(mode, cycleId);
    if (current && now - Number(current.generated_at) < intervalMs) continue;
    try {
      if (refresh) refresh(db, mode, cycleId);
      else if (mode === "regular") materializeRegularProgression(db);
      else refreshSqliteProgressionAggregates(db, mode, cycleId);
      published.push({ mode, cycleId, ...publish(db, mode, cycleId, now) });
    } catch (error) {
      errors.push({ mode, cycleId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { published, errors };
}

export async function materializeProgressionPopulation(reason = "manual") {
  if (running) return { skipped: true };
  running = true;
  const startedAt = Date.now();
  let db;
  try {
    db = new DatabaseSync(databasePath);
    db.exec("PRAGMA busy_timeout = 5000");
    initializeSeasonalSchema(db);
    const cycles = db.prepare("SELECT cycle_id FROM season_cycles WHERE mode = 'seasonal' AND enabled = 1")
      .all().map((row) => String(row.cycle_id));
    const configuredCycle = process.env.SEASONAL_ENABLED === "true" ? process.env.SEASONAL_CYCLE_ID?.trim() : null;
    if (configuredCycle && !cycles.includes(configuredCycle)) cycles.push(configuredCycle);
    const result = materializeDuePopulations(db, [
      { mode: "regular", cycleId: "persistent" },
      ...cycles.map((cycleId) => ({ mode: "seasonal", cycleId })),
    ]);
    if (result.published.length || result.errors.length) {
      console.log(`progression population checked (${reason}) in ${Date.now() - startedAt}ms`, result);
    }
    return { skipped: false, ...result };
  } catch (error) {
    console.warn(`progression population materialization failed (${reason}): ${error instanceof Error ? error.message : String(error)}`);
    return { skipped: false, error };
  } finally {
    db?.close();
    running = false;
  }
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/scripts/materialize-progression-population.mjs")) {
  void materializeAchievementBaselines("startup");
  setInterval(() => {
    void materializeAchievementBaselines("interval");
  }, intervalMs);
  if (initialDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, initialDelayMs));
  await materializeProgressionPopulation("startup");
  // Failed publications retain their old generation and remain due on each
  // check. Successful scopes are left alone for their normal six-hour cycle.
  setInterval(() => { void materializeProgressionPopulation("retry-check"); }, retryIntervalMs);
}
