/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-ignore -- Node's strip-types test runner requires the extension; Next accepts it.
import type { D1DatabaseLike } from "./d1.ts";
// @ts-ignore -- Node's strip-types test runner requires the extension; Next accepts it.
import { d1Changes, d1Rows } from "./d1.ts";
// @ts-ignore -- Node's strip-types test runner requires the extension; Next accepts it.
import { mapRun, mapTask, SYSTEM_ERRORS, validateScope, type OperatorTaskOutcome } from "./operator.ts";

export function createD1SeasonalOperatorStore(db: D1DatabaseLike) {
  const activeLease = async (input: { runId: number; taskId: number; owner: string; now?: number }) => {
    const now = input.now ?? Date.now();
    const row = await db.prepare(`SELECT t.id, t.aid, t.kind, t.mode, t.cycle_id
      FROM scan_runs r JOIN scan_tasks t ON t.mode = r.mode AND t.cycle_id = r.cycle_id
      WHERE r.id = ? AND r.owner = ? AND r.state = 'running' AND t.id = ?
        AND t.state = 'leased' AND t.lease_owner = ? AND t.leased_until > ?`)
      .bind(input.runId, input.owner, input.taskId, input.owner, now).first() as Record<string, unknown> | null;
    return row ? { id: Number(row.id), aid: Number(row.aid), kind: String(row.kind), mode: String(row.mode), cycleId: String(row.cycle_id) } : null;
  };

  const store = {
    activeLease,

    async confirmBanned(input: { runId: number; taskId: number; owner: string; aid: number; cycleId: string; now?: number }) {
      const now = input.now ?? Date.now();
      const lease = await activeLease({ ...input, now });
      if (!lease || lease.kind !== "ban_check" || lease.aid !== input.aid || lease.cycleId !== input.cycleId) throw new Error("active ban-check lease not found");
      const results = await db.batch([
        db.prepare("UPDATE player_profiles SET confirmed_banned = 1 WHERE mode = 'seasonal' AND cycle_id = ? AND aid = ?").bind(input.cycleId, input.aid),
        db.prepare(`INSERT INTO upstream_ban_confirmations
          (aid, mode, cycle_id, source, confirmed_at)
          VALUES (?, 'seasonal', ?, 'seasonal_upstream', ?)
          ON CONFLICT(aid, mode, cycle_id, source) DO UPDATE SET
            confirmed_at = MAX(upstream_ban_confirmations.confirmed_at, excluded.confirmed_at)`)
          .bind(input.aid, input.cycleId, now),
        db.prepare("UPDATE scan_members SET active = 0 WHERE mode = 'seasonal' AND cycle_id = ? AND aid = ?").bind(input.cycleId, input.aid),
      ]);
      if (d1Changes(results[0]) !== 1) throw new Error("Seasonal profile not found");
    },

    async beginOrResumeRun(cycleId: string, owner: string, now = Date.now()) {
      validateScope(cycleId, owner);
      let row = await db.prepare(`SELECT * FROM scan_runs WHERE mode = 'seasonal' AND cycle_id = ?
        AND owner = ? AND state = 'running' ORDER BY id DESC LIMIT 1`).bind(cycleId, owner).first() as Record<string, unknown> | null;
      const resumed = Boolean(row);
      if (!row) {
        await db.prepare(`INSERT OR IGNORE INTO scan_runs (mode, cycle_id, owner, state, started_at, updated_at)
          VALUES ('seasonal', ?, ?, 'running', ?, ?)`).bind(cycleId, owner, now, now).run();
        row = await db.prepare(`SELECT * FROM scan_runs WHERE mode = 'seasonal' AND cycle_id = ?
          AND owner = ? AND state = 'running' ORDER BY id DESC LIMIT 1`).bind(cycleId, owner).first() as Record<string, unknown> | null;
      }
      if (!row) throw new Error("active run could not be created");
      return { ...mapRun(row), resumed };
    },

    async claimNext(runId: number, owner: string, now = Date.now()): Promise<Record<string, unknown>> {
      if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error("invalid runId");
      if (!owner.trim()) throw new Error("invalid owner");
      const run = await db.prepare("SELECT * FROM scan_runs WHERE id = ? AND owner = ? AND state = 'running'")
        .bind(runId, owner).first() as Record<string, unknown> | null;
      if (!run) throw new Error("active run not found");
      const task = await db.prepare(`SELECT * FROM scan_tasks WHERE mode = 'seasonal' AND cycle_id = ?
        AND available_at <= ? AND kind IN ('profile', 'linked_pvp', 'ban_check')
        AND (state = 'queued' OR (state = 'leased' AND leased_until <= ?))
        ORDER BY priority, available_at, created_at, id LIMIT 1`).bind(String(run.cycle_id), now, now).first() as Record<string, unknown> | null;
      if (!task) {
        const live = await db.prepare(`SELECT MIN(leased_until) AS retry_at FROM scan_tasks
          WHERE mode = 'seasonal' AND cycle_id = ? AND state = 'leased' AND lease_owner = ? AND leased_until > ?`)
          .bind(String(run.cycle_id), owner, now).first() as { retry_at: number | null } | null;
        if (live?.retry_at != null) return { run: mapRun(run), task: null, retryAt: Number(live.retry_at) };
        const result = await db.prepare(`UPDATE scan_runs SET state = 'completed', updated_at = ?, finished_at = ?
          WHERE id = ? AND owner = ? AND state = 'running'`).bind(now, now, runId, owner).run();
        if (d1Changes(result) !== 1) throw new Error("active run changed");
        return { run: { ...mapRun(run), state: "completed", updatedAt: now, finishedAt: now }, task: null };
      }
      const update = await db.prepare(`UPDATE scan_tasks SET state = 'leased', lease_owner = ?, leased_until = ?,
        attempts = attempts + 1, updated_at = ? WHERE id = ?
        AND (state = 'queued' OR (state = 'leased' AND leased_until <= ?))`)
        .bind(owner, now + 5 * 60_000, now, Number(task.id), now).run();
      if (d1Changes(update) !== 1) return store.claimNext(runId, owner, now);
      await db.prepare("UPDATE scan_runs SET updated_at = ? WHERE id = ?").bind(now, runId).run();
      const claimed = await db.prepare("SELECT * FROM scan_tasks WHERE id = ?").bind(Number(task.id)).first() as Record<string, unknown>;
      return { run: mapRun({ ...run, updated_at: now }), task: mapTask(claimed) };
    },

    async recordOutcome(input: { runId: number; taskId: number; owner: string; outcome: OperatorTaskOutcome; detail?: string | null; now?: number }) {
      const now = input.now ?? Date.now();
      if (!SYSTEM_ERRORS.has(input.outcome) && !["completed", "skipped", "not_found"].includes(input.outcome)) throw new Error("invalid outcome");
      if (input.detail != null && input.detail.length > 500) throw new Error("outcome detail is too long");
      const row = await db.prepare(`SELECT r.consecutive_errors, r.state AS run_state, t.attempts FROM scan_runs r JOIN scan_tasks t
        ON t.mode = r.mode AND t.cycle_id = r.cycle_id WHERE r.id = ? AND r.owner = ? AND t.id = ?
        AND t.state = 'leased' AND t.lease_owner = ? AND t.leased_until > ?`)
        .bind(input.runId, input.owner, input.taskId, input.owner, now).first() as Record<string, unknown> | null;
      if (!row || row.run_state !== "running") throw new Error("leased task not found for active run");
      const consecutiveErrors = SYSTEM_ERRORS.has(input.outcome) ? Number(row.consecutive_errors) + 1 : 0;
      const stopped = consecutiveErrors >= 5;
      const results = await db.batch([
        db.prepare(`INSERT OR IGNORE INTO scan_task_outcomes
          (run_id, task_id, attempt, outcome, detail, created_at)
          SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (
            SELECT 1 FROM scan_runs r JOIN scan_tasks t
              ON t.mode = r.mode AND t.cycle_id = r.cycle_id
            WHERE r.id = ? AND r.owner = ? AND r.state = 'running' AND t.id = ?
              AND t.state = 'leased' AND t.lease_owner = ? AND t.leased_until > ? AND t.attempts = ?
          )`).bind(input.runId, input.taskId, Number(row.attempts), input.outcome, input.detail ?? null, now,
          input.runId, input.owner, input.taskId, input.owner, now, Number(row.attempts)),
        db.prepare(`UPDATE scan_tasks SET state = ?, lease_owner = NULL, leased_until = NULL,
          consecutive_errors = ?, updated_at = ? WHERE id = ? AND state = 'leased' AND lease_owner = ?
          AND leased_until > ? AND attempts = ?`)
          .bind(input.outcome, SYSTEM_ERRORS.has(input.outcome) ? 1 : 0, now, input.taskId, input.owner, now,
            Number(row.attempts)),
        db.prepare(`UPDATE scan_runs SET state = ?, consecutive_errors = ?, updated_at = ?, finished_at = ?
          WHERE id = ? AND owner = ? AND state = 'running' AND changes() = 1`).bind(stopped ? "stopped" : "running",
          consecutiveErrors, now, stopped ? now : null, input.runId, input.owner),
      ]);
      if (d1Changes(results[0]) !== 1 || d1Changes(results[1]) !== 1 || d1Changes(results[2]) !== 1) {
        throw new Error("lease changed during outcome");
      }
      return { stopped, exitCode: stopped ? 1 : 0, consecutiveErrors };
    },

    async status(cycleId: string, now = Date.now()) {
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(cycleId)) throw new Error("invalid cycleId");
      const results = await db.batch([
        db.prepare("SELECT * FROM scan_runs WHERE mode = 'seasonal' AND cycle_id = ? ORDER BY id DESC LIMIT 1").bind(cycleId),
        db.prepare("SELECT COUNT(*) AS n FROM scan_members WHERE mode = 'seasonal' AND cycle_id = ? AND active = 1").bind(cycleId),
        db.prepare(`SELECT COUNT(DISTINCT s.aid) AS n FROM progression_snapshots s JOIN scan_members m
          ON m.mode = s.mode AND m.cycle_id = s.cycle_id AND m.aid = s.aid AND m.active = 1
          WHERE s.mode = 'seasonal' AND s.cycle_id = ?`).bind(cycleId),
        db.prepare(`SELECT id, aid, kind, priority, state, available_at FROM scan_tasks WHERE mode = 'seasonal' AND cycle_id = ?
          AND (state = 'queued' AND available_at <= ? OR state = 'leased' AND leased_until <= ?)
          ORDER BY priority, available_at, id LIMIT 100`).bind(cycleId, now, now),
        db.prepare(`SELECT o.task_id, t.aid, t.kind, o.outcome, o.detail, o.created_at FROM scan_task_outcomes o
          JOIN scan_tasks t ON t.id = o.task_id WHERE t.mode = 'seasonal' AND t.cycle_id = ?
          AND o.outcome IN ('rate_limited', 'upstream_error', 'schema_error') ORDER BY o.created_at DESC, o.id DESC LIMIT 100`).bind(cycleId),
        db.prepare(`SELECT id, aid, priority, state, available_at FROM scan_tasks WHERE mode = 'seasonal' AND cycle_id = ?
          AND kind = 'ban_check' AND state IN ('queued', 'leased') ORDER BY priority, available_at, id LIMIT 100`).bind(cycleId),
        db.prepare(`SELECT t.id, t.aid, t.kind, t.priority, t.state, t.available_at FROM scan_tasks t LEFT JOIN scan_members m
          ON m.mode = t.mode AND m.cycle_id = t.cycle_id AND m.aid = t.aid AND m.active = 1
          WHERE t.mode = 'seasonal' AND t.cycle_id = ? AND m.aid IS NULL AND t.kind <> 'ban_check'
          AND t.state IN ('queued', 'leased') ORDER BY t.priority, t.available_at, t.id LIMIT 100`).bind(cycleId),
        db.prepare(`SELECT
          SUM(CASE WHEN status = 'valid' AND pmc_raids > 0 AND
            (tempo_score IS NULL OR form_score IS NULL OR score_sample_n IS NULL) THEN 1 ELSE 0 END) AS unprocessed_raid_intervals,
          MAX(ended_at) AS last_interval_at
          FROM progression_intervals WHERE mode = 'seasonal' AND cycle_id = ?`).bind(cycleId),
        db.prepare(`SELECT generation, materialized_at FROM progression_materializations
          WHERE mode = 'seasonal' AND cycle_id = ?`).bind(cycleId),
      ]);
      const run = d1Rows(results[0])[0];
      const progression = d1Rows(results[7])[0] ?? {};
      const materialization = d1Rows(results[8])[0] ?? {};
      return { run: run ? mapRun(run) : null,
        coverage: { panel: Number(d1Rows(results[1])[0]?.n ?? 0), captured: Number(d1Rows(results[2])[0]?.n ?? 0) },
        progression: {
          unprocessedRaidIntervals: Number(progression.unprocessed_raid_intervals ?? 0),
          lastIntervalAt: progression.last_interval_at == null ? null : Number(progression.last_interval_at),
          generation: Number(materialization.generation ?? 0),
          materializedAt: materialization.materialized_at == null ? null : Number(materialization.materialized_at),
        },
        stale: d1Rows(results[3]), errors: d1Rows(results[4]), banQueue: d1Rows(results[5]), community: d1Rows(results[6]) };
    },
  };
  return store;
}
