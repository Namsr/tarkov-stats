import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import { existsSync } from "node:fs";
import { materializeRegularProgression, PERSISTENT_MATERIALIZATION_VERSION } from "../lib/regular-progression.ts";
import { refreshSqliteProgressionAggregates } from "../lib/seasonal/daily-aggregates.ts";
import {
  materializeSqlitePopulationSnapshot,
} from "../lib/seasonal/progression-db.ts";
import { initializeSeasonalSchema, upsertSqliteSeasonCycle } from "../lib/seasonal/storage.ts";
import { loadSeasonalCycleConfig } from "../lib/seasonal/config.ts";
import { backfillRegularRiskReferences } from "../lib/regular-risk-reference-backfill.ts";
import { retrySqliteBusy } from "../lib/sqlite-busy-retry.ts";
import {
  ACHIEVEMENT_BASELINE_PUBLICATION_SCHEMA,
  materializeAchievementBaseline,
  materializeRegularRiskAchievementOwners,
  readPublishedAchievementBaseline,
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

export function materializeDueAchievementBaselines(db, { now = Date.now(), publish = materializeAchievementBaseline } = {}) {
  db.exec(ACHIEVEMENT_BASELINE_PUBLICATION_SCHEMA);
  const published = [];
  const errors = [];
  const phases = [];
  for (const mode of ["regular", "pve"]) {
    const startedAt = Date.now();
    try {
      const current = readPublishedAchievementBaseline(db, mode);
      const age = current ? now - current.generatedAt : Infinity;
      const riskReferencesReady = mode !== "regular" || db.prepare(
        "SELECT 1 FROM regular_risk_reference_state WHERE id = 1"
      ).get();
      if (!riskReferencesReady) {
        const started = Date.now();
        materializeRegularRiskAchievementOwners(db, now);
        phases.push({ mode, phase: "risk_owners", durationMs: Date.now() - started });
      }
      if (age >= 0 && age < intervalMs) continue;
      const publishStarted = Date.now();
      published.push(publish(db, mode, now));
      phases.push({ mode, phase: "baseline_publish", durationMs: Date.now() - publishStarted });
    } catch (error) {
      errors.push({ mode, error: error instanceof Error ? error.message : String(error) });
      phases.push({ mode, phase: "failed", durationMs: Date.now() - startedAt });
    }
  }
  return { published, errors, phases };
}

function materializeAchievementBaselines(reason) {
  const startedAt = Date.now();
  let db;
  let snapshots;
  let riskBackfillMs = 0;
  try {
    db = new DatabaseSync(playersDatabasePath);
    db.exec("PRAGMA busy_timeout = 5000");
    // On first startup the population step below creates the snapshot database.
    if (existsSync(databasePath)) {
      snapshots = new DatabaseSync(databasePath, { readOnly: true });
      const backfillStarted = Date.now();
      const riskRows = backfillRegularRiskReferences(db, snapshots);
      riskBackfillMs = Date.now() - backfillStarted;
      if (riskRows) console.log("regular risk references backfilled", { updated: riskRows });
    }
    const result = materializeDueAchievementBaselines(db);
    const published = result.published.map(({ mode, generation, generatedAt, total, achievements }) => ({
      mode, generation, generatedAt, total, achievements: achievements.length,
    }));
    if (reason === "startup" || published.length || result.errors.length) {
      console.log(`achievement baselines checked (${reason}) in ${Date.now() - startedAt}ms`, { published, errors: result.errors, riskBackfillMs, phases: result.phases });
    }
    return { skipped: published.length === 0 && result.errors.length === 0, ...result };
  } catch (error) {
    console.warn(`achievement baseline materialization failed (${reason}): ${error instanceof Error ? error.message : String(error)}`);
    return { skipped: false, error };
  } finally {
    snapshots?.close();
    db?.close();
  }
}

export async function materializeDuePopulations(db, scopes, { now = Date.now(), refresh, publish = materializeSqlitePopulationSnapshot } = {}) {
  const published = [];
  const errors = [];
  const phases = [];
  for (const { mode, cycleId } of scopes) {
    const current = db.prepare(`SELECT c.generated_at, json_type(g.payload, '$.average') AS average_type
      FROM progression_population_current c JOIN progression_population_generations g
        ON g.mode = c.mode AND g.cycle_id = c.cycle_id AND g.generation = c.generation
      WHERE c.mode = ? AND c.cycle_id = ?`).get(mode, cycleId);
    if (current?.average_type === "object" && now - Number(current.generated_at) < intervalMs) continue;
    const startedAt = Date.now();
    const phase = { mode, cycleId, normalizeMs: 0, normalizedPlayers: 0, refreshMs: 0, publishMs: 0 };
    let activePhase = "refreshMs";
    let phaseStarted = Date.now();
    try {
      let refreshStarted = Date.now();
      if (refresh) await retrySqliteBusy(() => refresh(db, mode, cycleId));
      else if (mode === "regular") {
        // Captures need the same writer. Commit one complete player's repair at
        // a time; a failed publication continues serving its previous generation.
        // The identity index and revision tables are small. Avoid reading every
        // unchanged raw history daily; unmarked legacy identities still repair.
        activePhase = "normalizeMs";
        phaseStarted = Date.now();
        const normalizationStarted = phaseStarted;
        const aids = db.prepare(`SELECT DISTINCT s.aid FROM progression_snapshots s
          LEFT JOIN progression_normalizations n ON n.mode = s.mode AND n.cycle_id = s.cycle_id AND n.aid = s.aid
          LEFT JOIN progression_personal_revisions r ON r.mode = s.mode AND r.cycle_id = s.cycle_id AND r.aid = s.aid
          WHERE s.mode = 'regular' AND s.cycle_id = 'persistent'
            AND (n.aid IS NULL OR n.version != ? OR n.revision != COALESCE(r.revision, 0))
          ORDER BY s.aid`).all(PERSISTENT_MATERIALIZATION_VERSION);
        phase.normalizedPlayers = 0;
        for (const { aid } of aids) {
          // A stale WAL read snapshot must be rolled back and retried. Keep
          // already committed players instead of restarting the whole scope.
          await retrySqliteBusy(() => materializeRegularProgression(db, Number(aid), { refreshAggregates: false }));
          phase.normalizedPlayers += 1;
        }
        phase.normalizeMs = Date.now() - normalizationStarted;
        refreshStarted = Date.now();
        activePhase = "refreshMs";
        phaseStarted = refreshStarted;
        await retrySqliteBusy(() => refreshSqliteProgressionAggregates(db, mode, cycleId));
      }
      else await retrySqliteBusy(() => refreshSqliteProgressionAggregates(db, mode, cycleId));
      phase.refreshMs = Date.now() - refreshStarted;
      const publishStarted = Date.now();
      activePhase = "publishMs";
      phaseStarted = publishStarted;
      published.push({ mode, cycleId, ...await retrySqliteBusy(() => publish(db, mode, cycleId, now)) });
      phase.publishMs = Date.now() - publishStarted;
    } catch (error) {
      phase[activePhase] = Date.now() - phaseStarted;
      errors.push({ mode, cycleId, error: error instanceof Error ? error.message : String(error) });
    } finally {
      phases.push({ ...phase, totalMs: Date.now() - startedAt });
    }
  }
  return { published, errors, phases };
}

export async function materializeProgressionPopulation(reason = "manual") {
  if (running) return { skipped: true };
  running = true;
  const startedAt = Date.now();
  let db;
  try {
    db = new DatabaseSync(databasePath);
    db.exec("PRAGMA busy_timeout = 250");
    await retrySqliteBusy(() => initializeSeasonalSchema(db));
    const cycleConfig = loadSeasonalCycleConfig();
    if (cycleConfig) await retrySqliteBusy(() => upsertSqliteSeasonCycle(db, cycleConfig));
    const cycles = db.prepare("SELECT cycle_id FROM season_cycles WHERE mode = 'seasonal' AND enabled = 1")
      .all().map((row) => String(row.cycle_id));
    const configuredCycle = process.env.SEASONAL_ENABLED === "true" ? process.env.SEASONAL_CYCLE_ID?.trim() : null;
    if (configuredCycle && !cycles.includes(configuredCycle)) cycles.push(configuredCycle);
    const result = await materializeDuePopulations(db, [
      { mode: "regular", cycleId: "persistent" },
      { mode: "pve", cycleId: "persistent" },
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
  // Population sorts can exceed the worker's /tmp tmpfs; use the writable data volume.
  process.env.SQLITE_TMPDIR ||= dirname(playersDatabasePath);
  const once = process.env.PROGRESSION_MATERIALIZE_ONCE === "true";
  const baselines = materializeAchievementBaselines("startup");
  if (!once && initialDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, initialDelayMs));
  const populations = await materializeProgressionPopulation("startup");
  if (once) {
    if (baselines.error || baselines.errors?.length || populations.error || populations.errors?.length) {
      process.exitCode = 1;
    }
  } else {
    // Failed publications retain their old generation and remain due.
    setInterval(() => { void materializeAchievementBaselines("retry-check"); }, retryIntervalMs);
    setInterval(() => { void materializeProgressionPopulation("retry-check"); }, retryIntervalMs);
  }
}
