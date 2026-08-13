/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-ignore -- Node's strip-types test runner requires the extension; Next accepts it.
import type { D1DatabaseLike } from "./d1.ts";
// @ts-ignore -- Node's strip-types test runner requires the extension; Next accepts it.
import { d1Changes, d1Rows } from "./d1.ts";
// @ts-ignore -- Node's strip-types test runner requires the extension; Next accepts it.
import { mapRefreshCandidate, mapRefreshRun, mapRun, mapTask, normalizeProgressionRefreshCandidates, PROGRESSION_REFRESH_SCHEMA, SYSTEM_ERRORS, validateRefreshIdentifiers, validateScope, type OperatorTaskOutcome, type ProgressionRefreshFeedCandidate, type ProgressionRefreshOutcome } from "./operator.ts";

export function createD1SeasonalOperatorStore(db: D1DatabaseLike) {
  const refreshSchemaReady = typeof db.exec === "function"
    ? db.exec(PROGRESSION_REFRESH_SCHEMA)
    : Promise.resolve();
  const ensureRefreshSchema = async () => { await refreshSchemaReady; };
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
    async beginOrResumeProgressionRefreshRun(cycleId: string, owner: string, now = Date.now()) {
      await ensureRefreshSchema();
      validateScope(cycleId, owner);
      let run = await db.prepare(`SELECT * FROM seasonal_progression_refresh_runs
        WHERE cycle_id = ? AND owner = ? AND state = 'running' ORDER BY id DESC LIMIT 1`)
        .bind(cycleId, owner).first() as Record<string, unknown> | null;
      let resumed = true;
      if (!run) {
        await db.prepare(`INSERT INTO seasonal_progression_refresh_runs
          (cycle_id, owner, state, started_at, updated_at) VALUES (?, ?, 'running', ?, ?)`)
          .bind(cycleId, owner, now, now).run();
        run = await db.prepare(`SELECT * FROM seasonal_progression_refresh_runs
          WHERE cycle_id = ? AND owner = ? AND state = 'running' ORDER BY id DESC LIMIT 1`)
          .bind(cycleId, owner).first() as Record<string, unknown> | null;
        if (!run) throw new Error("progression refresh run could not be created");
        await db.prepare(`INSERT INTO seasonal_progression_refresh_candidates
          (run_id, cycle_id, aid, latest_captured_at, state, updated_at)
          SELECT ?, s.cycle_id, s.aid, MAX(s.captured_at), 'queued', ?
          FROM progression_snapshots s
          LEFT JOIN player_profiles p ON p.mode = s.mode AND p.cycle_id = s.cycle_id AND p.aid = s.aid
          WHERE s.mode = 'seasonal' AND s.cycle_id = ? AND COALESCE(p.confirmed_banned, 0) = 0
            AND NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = s.aid)
          GROUP BY s.cycle_id, s.aid ORDER BY MAX(s.captured_at), s.aid`)
          .bind(Number(run.id), now, cycleId).run();
        resumed = false;
      }
      return { run: mapRefreshRun(run), resumed };
    },

    async restartProgressionRefreshRun(
      cycleId: string,
      owner: string,
      candidates: readonly ProgressionRefreshFeedCandidate[],
      now = Date.now(),
    ) {
      await ensureRefreshSchema();
      validateScope(cycleId, owner);
      const ordered = normalizeProgressionRefreshCandidates(candidates);
      let run = await db.prepare(`SELECT * FROM seasonal_progression_refresh_runs
        WHERE cycle_id = ? AND owner = ? AND state = 'running' ORDER BY id DESC LIMIT 1`)
        .bind(cycleId, owner).first() as Record<string, unknown> | null;
      let runId: number;
      if (run) {
        runId = Number(run.id);
        await db.batch([
          db.prepare(`UPDATE seasonal_progression_refresh_runs
            SET state = 'running', started_at = ?, updated_at = ?, finished_at = NULL
            WHERE id = ?`).bind(now, now, runId),
          db.prepare("DELETE FROM seasonal_progression_refresh_candidates WHERE run_id = ?").bind(runId),
        ]);
      } else {
        await db.prepare(`INSERT OR IGNORE INTO seasonal_progression_refresh_runs
          (cycle_id, owner, state, started_at, updated_at) VALUES (?, ?, 'running', ?, ?)`)
          .bind(cycleId, owner, now, now).run();
        run = await db.prepare(`SELECT * FROM seasonal_progression_refresh_runs
          WHERE cycle_id = ? AND owner = ? AND state = 'running' ORDER BY id DESC LIMIT 1`)
          .bind(cycleId, owner).first() as Record<string, unknown> | null;
        if (!run) throw new Error("progression refresh run could not be created");
        runId = Number(run.id);
      }

      const insertSql = `
          INSERT INTO seasonal_progression_refresh_candidates
            (run_id, cycle_id, aid, latest_captured_at, state, updated_at)
          SELECT ?, ?, CAST(json_extract(value, '$.aid') AS INTEGER),
            CAST(json_extract(value, '$.updatedAt') AS INTEGER), 'queued', ?
          FROM json_each(?)
          WHERE NOT EXISTS (
              SELECT 1 FROM excluded_players e
              WHERE e.aid = CAST(json_extract(value, '$.aid') AS INTEGER)
            )
            AND NOT EXISTS (
              SELECT 1 FROM player_profiles p
              WHERE p.mode = 'seasonal' AND p.cycle_id = ?
                AND p.aid = CAST(json_extract(value, '$.aid') AS INTEGER)
                AND COALESCE(p.confirmed_banned, 0) = 1
            )
        `;
      const insertStatements = [];
      for (let index = 0; index < ordered.length; index += 500) {
        insertStatements.push(db.prepare(insertSql).bind(
          runId, cycleId, now, JSON.stringify(ordered.slice(index, index + 500)), cycleId,
        ));
      }
      await db.batch(insertStatements);
      run = await db.prepare("SELECT * FROM seasonal_progression_refresh_runs WHERE id = ?")
        .bind(runId).first() as Record<string, unknown> | null;
      const accepted = await db.prepare(`SELECT COUNT(*) AS n
        FROM seasonal_progression_refresh_candidates WHERE run_id = ?`).bind(runId).first() as { n: number };
      return {
        run: mapRefreshRun(run!),
        requested: ordered.length,
        accepted: Number(accepted?.n ?? 0),
        excluded: ordered.length - Number(accepted?.n ?? 0),
      };
    },

    async claimNextProgressionRefresh(runId: number, owner: string, now = Date.now()) {
      await ensureRefreshSchema();
      validateRefreshIdentifiers(runId);
      if (!owner.trim()) throw new Error("refresh lease owner is required");
      const run = await db.prepare(`SELECT * FROM seasonal_progression_refresh_runs
        WHERE id = ? AND owner = ? AND state = 'running'`).bind(runId, owner).first() as Record<string, unknown> | null;
      if (!run) throw new Error("active progression refresh run not found");
      let candidate = await db.prepare(`SELECT * FROM seasonal_progression_refresh_candidates
        WHERE run_id = ? AND (state = 'queued' OR (state = 'leased' AND leased_until <= ?))
        ORDER BY latest_captured_at, aid LIMIT 1`).bind(runId, now).first() as Record<string, unknown> | null;
      if (!candidate) {
        const live = await db.prepare(`SELECT MIN(leased_until) AS retry_at
          FROM seasonal_progression_refresh_candidates WHERE run_id = ? AND state = 'leased' AND leased_until > ?`)
          .bind(runId, now).first() as { retry_at: number | null } | null;
        const remaining = await db.prepare(`SELECT COUNT(*) AS n FROM seasonal_progression_refresh_candidates
          WHERE run_id = ? AND state NOT IN ('completed', 'skipped', 'not_found')`).bind(runId).first() as { n: number };
        if (live?.retry_at != null) return { run: mapRefreshRun(run), candidate: null, retryAt: Number(live.retry_at), remaining: Number(remaining?.n ?? 0) };
        await db.prepare(`UPDATE seasonal_progression_refresh_runs SET state = 'completed', updated_at = ?, finished_at = ? WHERE id = ?`)
          .bind(now, now, runId).run();
        return { run: mapRefreshRun({ ...run, state: "completed", updated_at: now, finished_at: now }), candidate: null, remaining: 0 };
      }
      await db.prepare(`UPDATE seasonal_progression_refresh_candidates
        SET state = 'leased', lease_owner = ?, leased_until = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?`)
        .bind(owner, now + 10 * 60_000, now, Number(candidate.id)).run();
      candidate = await db.prepare("SELECT * FROM seasonal_progression_refresh_candidates WHERE id = ?")
        .bind(Number(candidate.id)).first() as Record<string, unknown>;
      await db.prepare("UPDATE seasonal_progression_refresh_runs SET updated_at = ? WHERE id = ?")
        .bind(now, runId).run();
      const remaining = await db.prepare(`SELECT COUNT(*) AS n FROM seasonal_progression_refresh_candidates
        WHERE run_id = ? AND state NOT IN ('completed', 'skipped', 'not_found')`).bind(runId).first() as { n: number };
      return { run: mapRefreshRun({ ...run, updated_at: now }), candidate: mapRefreshCandidate(candidate), remaining: Number(remaining?.n ?? 0) };
    },

    async activeProgressionRefreshLease(input: { runId: number; candidateId: number; owner: string; aid: number; cycleId: string; now?: number }) {
      await ensureRefreshSchema();
      const now = input.now ?? Date.now();
      validateRefreshIdentifiers(input.runId, input.candidateId, input.aid);
      const row = await db.prepare(`SELECT c.id, c.aid, c.cycle_id, c.state
        FROM seasonal_progression_refresh_candidates c JOIN seasonal_progression_refresh_runs r ON r.id = c.run_id
        WHERE c.run_id = ? AND c.id = ? AND c.aid = ? AND c.cycle_id = ? AND r.owner = ? AND r.state = 'running'
          AND c.state = 'leased' AND c.lease_owner = ? AND c.leased_until > ?`)
        .bind(input.runId, input.candidateId, input.aid, input.cycleId, input.owner, input.owner, now).first() as Record<string, unknown> | null;
      return row ? { id: Number(row.id), aid: Number(row.aid), cycleId: String(row.cycle_id), state: String(row.state) } : null;
    },

    async recordProgressionRefreshOutcome(input: {
      runId: number; candidateId: number; aid: number; cycleId: string; owner: string;
      outcome: ProgressionRefreshOutcome; now?: number;
    }) {
      await ensureRefreshSchema();
      const now = input.now ?? Date.now();
      validateRefreshIdentifiers(input.runId, input.candidateId, input.aid);
      if (!input.owner.trim()) throw new Error("refresh lease owner is required");
      const result = await db.prepare(`UPDATE seasonal_progression_refresh_candidates
        SET state = ?, outcome = ?, lease_owner = NULL, leased_until = NULL, updated_at = ?
        WHERE id = ? AND run_id = ? AND cycle_id = ? AND aid = ? AND state = 'leased'
          AND lease_owner = ? AND leased_until > ?`)
        .bind(input.outcome, input.outcome, now, input.candidateId, input.runId, input.cycleId,
          input.aid, input.owner, now).run();
      if (d1Changes(result) !== 1) throw new Error("progression refresh lease not found");
      await db.prepare("UPDATE seasonal_progression_refresh_runs SET updated_at = ? WHERE id = ?")
        .bind(now, input.runId).run();
      return { state: input.outcome };
    },

    async releaseProgressionRefreshLease(input: {
      runId: number;
      candidateId: number;
      aid: number;
      cycleId: string;
      owner: string;
      now?: number;
    }) {
      await ensureRefreshSchema();
      const now = input.now ?? Date.now();
      validateRefreshIdentifiers(input.runId, input.candidateId, input.aid);
      if (!input.owner.trim()) throw new Error("refresh lease owner is required");
      const result = await db.prepare(`
        UPDATE seasonal_progression_refresh_candidates
        SET state = 'queued', outcome = NULL, lease_owner = NULL, leased_until = NULL, updated_at = ?
        WHERE id = ? AND run_id = ? AND cycle_id = ? AND aid = ?
          AND state = 'leased' AND lease_owner = ?
      `).bind(now, input.candidateId, input.runId, input.cycleId, input.aid, input.owner).run();
      if (d1Changes(result) === 1) {
        await db.prepare("UPDATE seasonal_progression_refresh_runs SET updated_at = ? WHERE id = ?")
          .bind(now, input.runId).run();
      }
      return { released: d1Changes(result) === 1 };
    },

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
