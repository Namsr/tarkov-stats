import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { initializeTempoExclusions, materializeTempo } from "../lib/achievement-tempo-store.ts";
import { loadSeasonalCycleConfig } from "../lib/seasonal/config.ts";

export function materializeAchievementTempo() {
  const sourcePath = process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db";
  const outputPath = process.env.ACHIEVEMENT_TEMPO_SQLITE_PATH || join(dirname(sourcePath), "achievement-tempo.db");
  if (sourcePath === outputPath) throw new Error("tempo_output_must_be_separate");
  let source, output;
  const startedAt = Date.now();
  try {
    source = new DatabaseSync(sourcePath);
    source.exec("PRAGMA busy_timeout=250");
    initializeTempoExclusions(source);
    output = new DatabaseSync(outputPath);
    output.exec("PRAGMA busy_timeout=250; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL");
    const cycle = loadSeasonalCycleConfig();
    const scopes = [{ mode: "regular", cycleId: "persistent", startsAt: 0, endsAt: null }];
    if (cycle?.enabled) scopes.push({ mode: "seasonal", cycleId: cycle.cycleId, startsAt: cycle.startsAt, endsAt: cycle.endsAt });
    const results = [], errors = [];
    for (const scope of scopes) {
      try { results.push({ mode: scope.mode, ...materializeTempo(source, output, scope, { deadline: startedAt + 180_000 }) }); }
      catch (error) { errors.push({ mode: scope.mode, error: error.message }); }
    }
    console.log("achievement tempo publication", { durationMs: Date.now() - startedAt, results, errors });
    return { results, errors };
  } finally { output?.close(); source?.close(); }
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("/scripts/materialize-achievement-tempo.mjs")) {
  try { if (materializeAchievementTempo().errors.length) process.exitCode = 1; }
  catch (error) { console.error("achievement tempo failed", error); process.exitCode = 1; }
}
