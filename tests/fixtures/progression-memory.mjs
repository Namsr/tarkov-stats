import { DatabaseSync } from "node:sqlite";
import { initializeSeasonalSchema } from "../../lib/seasonal/storage.ts";
import { materializeRegularProgression } from "../../lib/regular-progression.ts";
import { materializeSqlitePopulationSnapshot } from "../../lib/seasonal/progression-db.ts";

const db = new DatabaseSync(":memory:");
initializeSeasonalSchema(db);
const stats = JSON.stringify({ nickname: "Fixture", hoursPlayed: 100, experience: 10000,
  pmcRaids: 10, scavRaids: 0, pmcSurvived: 5, pmcDeaths: 5, pmcKills: 20, killedPmc: 5,
  pmcKilledPmc: 5, pvpStatsKnown: true, padding: "x".repeat(64 * 1024) });
const insert = db.prepare(`INSERT INTO progression_snapshots
  (mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at, local_date, stats_json)
  VALUES ('regular', 'persistent', ?, 1720000000000, 1720000000000, 1720000000001, '2024-07-03', ?)`);
db.exec("BEGIN");
for (let aid = 1; aid <= 1500; aid += 1) insert.run(aid, stats);
db.exec("COMMIT");
const result = materializeRegularProgression(db);
materializeSqlitePopulationSnapshot(db, "regular", "persistent", 1720000000100);
const payload = JSON.parse(db.prepare("SELECT payload FROM progression_population_generations").get().payload);
if (result.snapshots !== 1500 || payload.metrics.xp.overall.at(-1)?.n !== 1500) throw new Error("lost population rows");
console.log(JSON.stringify({ snapshots: result.snapshots, inputJsonMiB: 1500 * stats.length / 1048576,
  heapMiB: process.memoryUsage().heapUsed / 1048576, peakRssMiB: process.resourceUsage().maxRSS / 1024 }));
db.close();
