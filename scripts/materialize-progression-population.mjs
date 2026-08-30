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

export async function materializeProgressionPopulation(reason = "manual") {
  if (running) return { skipped: true };
  running = true;
  const startedAt = Date.now();
  const db = new DatabaseSync(databasePath);
  try {
    initializeSeasonalSchema(db);
    materializeRegularProgression(db);
    const published = [{ mode: "regular", cycleId: "persistent", ...materializeSqlitePopulationSnapshot(
      db, "regular", "persistent",
    ) }];
    const cycles = db.prepare("SELECT cycle_id FROM season_cycles WHERE mode = 'seasonal' AND enabled = 1")
      .all().map((row) => String(row.cycle_id));
    const configuredCycle = process.env.SEASONAL_ENABLED === "true" ? process.env.SEASONAL_CYCLE_ID?.trim() : null;
    if (configuredCycle && !cycles.includes(configuredCycle)) cycles.push(configuredCycle);
    for (const cycleId of cycles) {
      refreshSqliteProgressionAggregates(db, "seasonal", cycleId);
      published.push({ mode: "seasonal", cycleId, ...materializeSqlitePopulationSnapshot(db, "seasonal", cycleId) });
    }
    console.log(`progression population materialized (${reason}) in ${Date.now() - startedAt}ms`, published);
    return { skipped: false, published };
  } catch (error) {
    console.warn(`progression population materialization failed (${reason}): ${error instanceof Error ? error.message : String(error)}`);
    return { skipped: false, error };
  } finally {
    db.close();
    running = false;
  }
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/scripts/materialize-progression-population.mjs")) {
  void materializeAchievementBaselines("startup");
  setInterval(() => {
    void materializeAchievementBaselines("interval");
    void materializeProgressionPopulation("interval");
  }, intervalMs);
  if (initialDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, initialDelayMs));
  await materializeProgressionPopulation("startup");
}
