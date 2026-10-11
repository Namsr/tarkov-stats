import { DatabaseSync } from "node:sqlite";
import { initializeSeasonalSchema } from "../../lib/seasonal/storage.ts";
import { refreshSqliteProgressionAggregates } from "../../lib/seasonal/daily-aggregates.ts";
import { materializeSqlitePopulationSnapshot } from "../../lib/seasonal/progression-db.ts";

const db = new DatabaseSync(":memory:");
initializeSeasonalSchema(db);
db.exec("PRAGMA temp_store = FILE");
const players = 10_000, buckets = 12;
const profile = db.prepare(`INSERT INTO player_profiles
  (mode,cycle_id,aid,nickname,profile_updated_at,last_access_at,lifetime_pvp_hours,experience,pmc_raids,
   scav_raids,pmc_survived,pmc_deaths,pmc_kills,killed_pmc,first_seen_at,last_seen_at)
  VALUES ('regular','persistent',?,'fixture',1720000000000,1720000000000,100,120000,120,0,60,60,240,60,1,1)`);
const snapshot = db.prepare(`INSERT INTO progression_snapshots
  (mode,cycle_id,aid,profile_updated_at,upstream_updated_at,captured_at,local_date,
   experience,pmc_raids,pmc_survived,pmc_deaths,pmc_kills,killed_pmc)
  VALUES ('regular','persistent',?,?,?,?, '2024-07-03',?,?,?,?,?,?)`);
const interval = db.prepare(`INSERT INTO progression_intervals
  (mode,cycle_id,aid,from_snapshot_id,to_snapshot_id,ended_at,local_date,elapsed_days,status,
   experience,pmc_raids,scav_raids,pmc_survived,pmc_deaths,pmc_kills,killed_pmc)
  VALUES ('regular','persistent',?,?,?,?,'2024-07-03',1,'valid',10000,10,0,5,5,20,5)`);
db.exec("BEGIN");
for (let aid = 1; aid <= players; aid += 1) {
  profile.run(aid);
  let previous;
  for (let bucket = 1; bucket <= buckets; bucket += 1) {
    const time = 1720000000000 + bucket * 86_400_000;
    const id = Number(snapshot.run(aid, time, time, time, bucket * 10000, bucket * 10,
      bucket * 5, bucket * 5, bucket * 20, bucket * 5).lastInsertRowid);
    if (previous) interval.run(aid, previous, id, time);
    previous = id;
  }
}
db.exec("COMMIT");
const result = refreshSqliteProgressionAggregates(db, "regular", "persistent");
materializeSqlitePopulationSnapshot(db, "regular", "persistent", 1730000000000);
const payload = JSON.parse(db.prepare("SELECT payload FROM progression_population_generations").get().payload);
if (payload.metrics.xp.overall.length !== buckets || payload.metrics.xp.overall.at(-1)?.n !== players) {
  throw new Error("lost population buckets or players");
}
globalThis.gc();
console.log(JSON.stringify({ snapshots: players * buckets, intervals: result.intervals,
  heapMiB: process.memoryUsage().heapUsed / 1048576 }));
db.close();
