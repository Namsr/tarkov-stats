import { DatabaseSync } from "node:sqlite";
import { materializeRegularProgression } from "../lib/regular-progression.ts";

const path = process.argv[2] || process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH;
if (!path) throw new Error("progression database path is required");
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
