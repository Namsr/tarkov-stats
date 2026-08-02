import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const path = process.argv[2] || process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH;
const requestedCycleId = process.argv[3] || process.env.SEASONAL_CYCLE_ID || null;
if (!path) throw new Error("progression database path is required");
if (!existsSync(path)) throw new Error(`progression database does not exist: ${path}`);

const db = new DatabaseSync(path);
try {
  const quickCheck = db.prepare("PRAGMA quick_check").get();
  if (Object.values(quickCheck)[0] !== "ok") throw new Error("progression database quick_check failed");

  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    .map((row) => String(row.name)));
  for (const table of ["progression_snapshots", "progression_intervals", "daily_aggregates", "progression_materializations"]) {
    if (!tables.has(table)) throw new Error(`required table is missing: ${table}`);
  }

  const count = (sql, args = []) => Number(db.prepare(sql).get(...args).n ?? 0);
  const inspect = (mode, cycleId) => {
    const badRaidIntervals = count(`SELECT COUNT(*) AS n FROM progression_intervals
      WHERE mode = ? AND cycle_id = ? AND status = 'valid' AND pmc_raids > 0
        AND (tempo_score IS NULL OR form_score IS NULL OR score_sample_n IS NULL)`, [mode, cycleId]);
    const badNonRaidScores = count(`SELECT COUNT(*) AS n FROM progression_intervals
      WHERE mode = ? AND cycle_id = ? AND (status <> 'valid' OR pmc_raids <= 0)
        AND (tempo_score IS NOT NULL OR form_score IS NOT NULL OR score_sample_n IS NOT NULL)`, [mode, cycleId]);
    const unprocessedRaidIntervals = badRaidIntervals;
    const intervalStats = db.prepare(`SELECT COUNT(*) AS all_intervals,
        MAX(ended_at) AS last_interval_at
      FROM progression_intervals WHERE mode = ? AND cycle_id = ?`).get(mode, cycleId);
    const materialization = db.prepare(`SELECT generation, materialized_at
      FROM progression_materializations WHERE mode = ? AND cycle_id = ?`).get(mode, cycleId);
    if (!materialization && Number(intervalStats.all_intervals ?? 0) > 0) {
      throw new Error(`${mode}/${cycleId} has intervals but no materialization revision`);
    }
    if (badRaidIntervals || badNonRaidScores) {
      throw new Error(`${mode}/${cycleId} score invariant failed: badRaidIntervals=${badRaidIntervals}, badNonRaidScores=${badNonRaidScores}`);
    }
    return {
      mode,
      cycleId,
      allIntervalCount: Number(intervalStats.all_intervals ?? 0),
      unprocessedRaidIntervals,
      lastIntervalAt: intervalStats.last_interval_at == null ? null : Number(intervalStats.last_interval_at),
      generation: materialization?.generation == null ? 0 : Number(materialization.generation),
      materializedAt: materialization?.materialized_at == null ? null : Number(materialization.materialized_at),
      materializationAgeMs: materialization?.materialized_at == null
        ? null
        : Math.max(0, Date.now() - Number(materialization.materialized_at)),
    };
  };

  const result = { quickCheck: "ok", regular: inspect("regular", "persistent") };
  const activeCycle = requestedCycleId || db.prepare(`SELECT cycle_id FROM season_cycles
    WHERE mode = 'seasonal' AND enabled = 1 ORDER BY starts_at DESC LIMIT 1`).get()?.cycle_id;
  if (activeCycle) result.seasonal = inspect("seasonal", String(activeCycle));
  console.log(JSON.stringify(result));
} finally {
  db.close();
}
