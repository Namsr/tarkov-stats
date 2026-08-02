// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SqliteDatabase = any;

export type OperatorTaskOutcome =
  | "completed"
  | "skipped"
  | "not_found"
  | "rate_limited"
  | "upstream_error"
  | "schema_error";

export const SYSTEM_ERRORS = new Set<OperatorTaskOutcome>([
  "rate_limited",
  "upstream_error",
  "schema_error",
]);

const OPERATOR_SCHEMA = `
CREATE TABLE IF NOT EXISTS scan_task_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  task_id INTEGER NOT NULL REFERENCES scan_tasks(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL DEFAULT 1,
  outcome TEXT NOT NULL CHECK (outcome IN (
    'completed', 'skipped', 'not_found', 'rate_limited', 'upstream_error', 'schema_error'
  )),
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scan_task_outcomes_run_time
  ON scan_task_outcomes(run_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_scan_runs_active_owner
  ON scan_runs(mode, cycle_id, owner) WHERE state = 'running';
`;

export function validateScope(cycleId: string, owner: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(cycleId)) throw new Error("invalid cycleId");
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(owner)) throw new Error("invalid owner");
}

export function createSqliteSeasonalOperatorStore(db: SqliteDatabase) {
  db.exec(OPERATOR_SCHEMA);
  const outcomeColumns = new Set((db.prepare("PRAGMA table_info(scan_task_outcomes)").all() as { name: string }[])
    .map((row) => row.name));
  if (!outcomeColumns.has("attempt")) {
    db.exec("ALTER TABLE scan_task_outcomes ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1");
  }
  db.exec(`DROP INDEX IF EXISTS idx_scan_task_outcomes_task;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_scan_task_outcomes_task_attempt
      ON scan_task_outcomes(run_id, task_id, attempt);`);

  return {
    activeLease(input: { runId: number; taskId: number; owner: string; now?: number }) {
      const now = input.now ?? Date.now();
      const row = db.prepare(`
        SELECT t.id, t.aid, t.kind, t.mode, t.cycle_id
        FROM scan_runs r JOIN scan_tasks t
          ON t.mode = r.mode AND t.cycle_id = r.cycle_id
        WHERE r.id = ? AND r.owner = ? AND r.state = 'running'
          AND t.id = ? AND t.state = 'leased' AND t.lease_owner = ? AND t.leased_until > ?
      `).get(input.runId, input.owner, input.taskId, input.owner, now) as Record<string, unknown> | undefined;
      return row ? {
        id: Number(row.id), aid: Number(row.aid), kind: String(row.kind),
        mode: String(row.mode), cycleId: String(row.cycle_id),
      } : null;
    },

    confirmBanned(input: { runId: number; taskId: number; owner: string; aid: number; cycleId: string; now?: number }) {
      const now = input.now ?? Date.now();
      db.exec("BEGIN IMMEDIATE");
      try {
        const lease = this.activeLease({ ...input, now });
        if (!lease || lease.kind !== "ban_check" || lease.aid !== input.aid || lease.cycleId !== input.cycleId) {
          throw new Error("active ban-check lease not found");
        }
        const result = db.prepare(`
          UPDATE player_profiles SET confirmed_banned = 1
          WHERE mode = 'seasonal' AND cycle_id = ? AND aid = ?
        `).run(input.cycleId, input.aid);
        if (Number(result.changes) !== 1) throw new Error("Seasonal profile not found");
        db.prepare(`INSERT INTO upstream_ban_confirmations
          (aid, mode, cycle_id, source, confirmed_at)
          VALUES (?, 'seasonal', ?, 'seasonal_upstream', ?)
          ON CONFLICT(aid, mode, cycle_id, source) DO UPDATE SET
            confirmed_at = MAX(upstream_ban_confirmations.confirmed_at, excluded.confirmed_at)`)
          .run(input.aid, input.cycleId, now);
        db.prepare(`UPDATE scan_members SET active = 0
          WHERE mode = 'seasonal' AND cycle_id = ? AND aid = ?`)
          .run(input.cycleId, input.aid);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    beginOrResumeRun(cycleId: string, owner: string, now = Date.now()) {
      validateScope(cycleId, owner);
      db.exec("BEGIN IMMEDIATE");
      try {
        let run = db.prepare(`
          SELECT * FROM scan_runs
          WHERE mode = 'seasonal' AND cycle_id = ? AND owner = ? AND state = 'running'
          ORDER BY id DESC LIMIT 1
        `).get(cycleId, owner) as Record<string, unknown> | undefined;
        let resumed = true;
        if (!run) {
          const inserted = db.prepare(`
            INSERT INTO scan_runs (mode, cycle_id, owner, state, started_at, updated_at)
            VALUES ('seasonal', ?, ?, 'running', ?, ?)
          `).run(cycleId, owner, now, now);
          run = db.prepare("SELECT * FROM scan_runs WHERE id = ?").get(Number(inserted.lastInsertRowid));
          resumed = false;
        }
        db.exec("COMMIT");
        return { ...mapRun(run!), resumed };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    claimNext(runId: number, owner: string, now = Date.now()) {
      if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error("invalid runId");
      if (!owner.trim()) throw new Error("invalid owner");
      db.exec("BEGIN IMMEDIATE");
      try {
        const run = db.prepare(
          "SELECT * FROM scan_runs WHERE id = ? AND owner = ? AND state = 'running'"
        ).get(runId, owner) as Record<string, unknown> | undefined;
        if (!run) throw new Error("active run not found");
        const task = db.prepare(`
          SELECT * FROM scan_tasks
          WHERE mode = 'seasonal' AND cycle_id = ? AND available_at <= ?
            AND kind IN ('profile', 'linked_pvp', 'ban_check')
            AND (state = 'queued' OR (state = 'leased' AND leased_until <= ?))
          ORDER BY priority, available_at, created_at, id
          LIMIT 1
        `).get(String(run.cycle_id), now, now) as Record<string, unknown> | undefined;
        if (!task) {
          const liveLease = db.prepare(`
            SELECT MIN(leased_until) AS retry_at FROM scan_tasks
            WHERE mode = 'seasonal' AND cycle_id = ? AND state = 'leased'
              AND lease_owner = ? AND leased_until > ?
          `).get(String(run.cycle_id), owner, now) as { retry_at: number | null };
          if (liveLease.retry_at != null) {
            db.exec("COMMIT");
            return { run: mapRun(run), task: null, retryAt: Number(liveLease.retry_at) };
          }
          db.prepare("UPDATE scan_runs SET state = 'completed', updated_at = ?, finished_at = ? WHERE id = ?")
            .run(now, now, runId);
          db.exec("COMMIT");
          return { run: { ...mapRun(run), state: "completed", updatedAt: now, finishedAt: now }, task: null };
        }
        db.prepare(`
          UPDATE scan_tasks SET state = 'leased', lease_owner = ?, leased_until = ?,
            attempts = attempts + 1, updated_at = ? WHERE id = ?
        `).run(owner, now + 5 * 60_000, now, Number(task.id));
        db.prepare("UPDATE scan_runs SET updated_at = ? WHERE id = ?").run(now, runId);
        const claimed = db.prepare("SELECT * FROM scan_tasks WHERE id = ?").get(Number(task.id));
        db.exec("COMMIT");
        return { run: mapRun({ ...run, updated_at: now }), task: mapTask(claimed) };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    recordOutcome(input: {
      runId: number;
      taskId: number;
      owner: string;
      outcome: OperatorTaskOutcome;
      detail?: string | null;
      now?: number;
    }) {
      const now = input.now ?? Date.now();
      if (!SYSTEM_ERRORS.has(input.outcome) && !["completed", "skipped", "not_found"].includes(input.outcome)) {
        throw new Error("invalid outcome");
      }
      if (input.detail != null && input.detail.length > 500) throw new Error("outcome detail is too long");
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db.prepare(`
          SELECT r.consecutive_errors, r.state AS run_state, t.mode, t.cycle_id, t.attempts
          FROM scan_runs r JOIN scan_tasks t
            ON t.mode = r.mode AND t.cycle_id = r.cycle_id
          WHERE r.id = ? AND r.owner = ? AND t.id = ?
            AND t.state = 'leased' AND t.lease_owner = ? AND t.leased_until > ?
        `).get(input.runId, input.owner, input.taskId, input.owner, now) as Record<string, unknown> | undefined;
        if (!row || row.run_state !== "running") throw new Error("leased task not found for active run");
        db.prepare(`
          INSERT INTO scan_task_outcomes (run_id, task_id, attempt, outcome, detail, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(input.runId, input.taskId, Number(row.attempts), input.outcome, input.detail ?? null, now);
        db.prepare(`
          UPDATE scan_tasks SET state = ?, lease_owner = NULL, leased_until = NULL,
            consecutive_errors = ?, updated_at = ? WHERE id = ?
        `).run(input.outcome, SYSTEM_ERRORS.has(input.outcome) ? 1 : 0, now, input.taskId);
        const consecutiveErrors = SYSTEM_ERRORS.has(input.outcome)
          ? Number(row.consecutive_errors) + 1
          : 0;
        const stopped = consecutiveErrors >= 5;
        db.prepare(`
          UPDATE scan_runs SET state = ?, consecutive_errors = ?, updated_at = ?, finished_at = ?
          WHERE id = ?
        `).run(stopped ? "stopped" : "running", consecutiveErrors, now, stopped ? now : null, input.runId);
        db.exec("COMMIT");
        return { stopped, exitCode: stopped ? 1 : 0, consecutiveErrors };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    status(cycleId: string, now = Date.now()) {
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(cycleId)) throw new Error("invalid cycleId");
      const run = db.prepare(`
        SELECT * FROM scan_runs WHERE mode = 'seasonal' AND cycle_id = ? ORDER BY id DESC LIMIT 1
      `).get(cycleId) as Record<string, unknown> | undefined;
      const scalar = (sql: string, ...args: unknown[]) => Number((db.prepare(sql).get(...args) as { n: number }).n);
      const stale = db.prepare(`
        SELECT id, aid, kind, priority, state, available_at
        FROM scan_tasks WHERE mode = 'seasonal' AND cycle_id = ?
          AND (state = 'queued' AND available_at <= ? OR state = 'leased' AND leased_until <= ?)
        ORDER BY priority, available_at, id LIMIT 100
      `).all(cycleId, now, now);
      const errors = db.prepare(`
        SELECT o.task_id, t.aid, t.kind, o.outcome, o.detail, o.created_at
        FROM scan_task_outcomes o JOIN scan_tasks t ON t.id = o.task_id
        WHERE t.mode = 'seasonal' AND t.cycle_id = ?
          AND o.outcome IN ('rate_limited', 'upstream_error', 'schema_error')
        ORDER BY o.created_at DESC, o.id DESC LIMIT 100
      `).all(cycleId);
      const banQueue = db.prepare(`
        SELECT id, aid, priority, state, available_at FROM scan_tasks
        WHERE mode = 'seasonal' AND cycle_id = ? AND kind = 'ban_check'
          AND state IN ('queued', 'leased') ORDER BY priority, available_at, id LIMIT 100
      `).all(cycleId);
      const community = db.prepare(`
        SELECT t.id, t.aid, t.kind, t.priority, t.state, t.available_at
        FROM scan_tasks t LEFT JOIN scan_members m
          ON m.mode = t.mode AND m.cycle_id = t.cycle_id AND m.aid = t.aid AND m.active = 1
        WHERE t.mode = 'seasonal' AND t.cycle_id = ? AND m.aid IS NULL
          AND t.kind <> 'ban_check' AND t.state IN ('queued', 'leased')
        ORDER BY t.priority, t.available_at, t.id LIMIT 100
      `).all(cycleId);
      const progression = db.prepare(`SELECT
        SUM(CASE WHEN status = 'valid' AND pmc_raids > 0 AND
          (tempo_score IS NULL OR form_score IS NULL OR score_sample_n IS NULL) THEN 1 ELSE 0 END) AS unprocessed_raid_intervals,
        MAX(ended_at) AS last_interval_at
        FROM progression_intervals WHERE mode = 'seasonal' AND cycle_id = ?`).get(cycleId) as Record<string, unknown>;
      const materialization = db.prepare(`SELECT generation, materialized_at
        FROM progression_materializations WHERE mode = 'seasonal' AND cycle_id = ?`).get(cycleId) as Record<string, unknown> | undefined;
      return {
        run: run ? mapRun(run) : null,
        coverage: {
          panel: scalar("SELECT COUNT(*) AS n FROM scan_members WHERE mode = 'seasonal' AND cycle_id = ? AND active = 1", cycleId),
          captured: scalar(`SELECT COUNT(DISTINCT s.aid) AS n FROM progression_snapshots s JOIN scan_members m
            ON m.mode = s.mode AND m.cycle_id = s.cycle_id AND m.aid = s.aid AND m.active = 1
            WHERE s.mode = 'seasonal' AND s.cycle_id = ?`, cycleId),
        },
        progression: {
          unprocessedRaidIntervals: Number(progression.unprocessed_raid_intervals ?? 0),
          lastIntervalAt: progression.last_interval_at == null ? null : Number(progression.last_interval_at),
          generation: Number(materialization?.generation ?? 0),
          materializedAt: materialization?.materialized_at == null ? null : Number(materialization.materialized_at),
        },
        stale,
        community,
        errors,
        banQueue,
      };
    },
  };
}

export function mapRun(row: Record<string, unknown>) {
  return {
    id: Number(row.id), mode: String(row.mode), cycleId: String(row.cycle_id), owner: String(row.owner),
    state: String(row.state), consecutiveErrors: Number(row.consecutive_errors),
    startedAt: Number(row.started_at), updatedAt: Number(row.updated_at),
    finishedAt: row.finished_at == null ? null : Number(row.finished_at),
  };
}

export function mapTask(row: Record<string, unknown>) {
  return {
    id: Number(row.id), mode: String(row.mode), cycleId: String(row.cycle_id), aid: Number(row.aid),
    kind: String(row.kind), priority: Number(row.priority), state: String(row.state),
    previousProfileUpdatedAt: row.previous_profile_updated_at == null ? null : Number(row.previous_profile_updated_at),
    leaseOwner: row.lease_owner == null ? null : String(row.lease_owner),
    leasedUntil: row.leased_until == null ? null : Number(row.leased_until), attempts: Number(row.attempts),
    availableAt: Number(row.available_at),
  };
}

let database: SqliteDatabase | null = null;

export async function getSeasonalOperatorStore() {
  const { getSeasonalD1 } = await import("./d1");
  const d1 = await getSeasonalD1();
  if (d1) {
    const { createD1SeasonalOperatorStore } = await import("./operator-d1");
    return createD1SeasonalOperatorStore(d1);
  }
  if (!database) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sqlite = (await import("node:sqlite" as string)) as any;
    database = new sqlite.DatabaseSync(
      process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db"
    );
    const { initializeSeasonalSchema } = await import("./storage");
    initializeSeasonalSchema(database);
  }
  return createSqliteSeasonalOperatorStore(database);
}
