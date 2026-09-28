import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { materializeRegularProgression } from "../lib/regular-progression.ts";

const path = process.argv[2] || process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH;
if (!path) throw new Error("progression database path is required");
// `DatabaseSync` creates the file when it is missing, so a mistyped path used to
// build a fresh empty database, have `materializeRegularProgression` create the
// schema in it, and report `quickCheck: ok` with every count at 0. The siblings
// (`backfill-progression.mjs`, `progression-smoke.mjs`) reject a missing file.
if (!existsSync(path)) throw new Error(`progression database does not exist: ${path}`);
const db = new DatabaseSync(path);
try {
  const check = db.prepare("PRAGMA quick_check").get();
  if (Object.values(check)[0] !== "ok") throw new Error("progression database quick_check failed");
  const result = materializeRegularProgression(db);
  const count = (table, extra = "") => db.prepare(`SELECT COUNT(*) AS n FROM ${table}
    WHERE mode = 'regular' AND cycle_id = 'persistent' ${extra}`).get().n;
  console.log(JSON.stringify({
    ...result,
    profiles: count("player_profiles"),
    eligible: count("player_profiles", "AND progression_eligible = 1"),
    storedIntervals: count("progression_intervals"),
    aggregates: count("daily_aggregates"),
    quickCheck: "ok",
  }));
} finally {
  db.close();
}
