/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- node:sqlite types are not present in the project's Node 20 type package.
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createSqliteSeasonalOperatorStore } from "../lib/seasonal/operator.ts";
import { createSqliteSeasonalStore } from "../lib/seasonal/storage.ts";

function setup() {
  const db = new DatabaseSync(":memory:");
  const queue = createSqliteSeasonalStore(db);
  const operator = createSqliteSeasonalOperatorStore(db);
  return { db, queue, operator };
}

test("resumes only the active run in the same cycle and owner scope", () => {
  const { operator } = setup();
  const first = operator.beginOrResumeRun("cycle-a", "runner-a", 1_000);
  const resumed = operator.beginOrResumeRun("cycle-a", "runner-a", 2_000);
  const otherCycle = operator.beginOrResumeRun("cycle-b", "runner-a", 3_000);

  assert.equal(first.resumed, false);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.id, first.id);
  assert.notEqual(otherCycle.id, first.id);
});

test("claims only tasks from the run cycle and completes an empty run", async () => {
  const { queue, operator } = setup();
  await queue.enqueueTask({ mode: "seasonal", cycleId: "cycle-b", aid: 2, kind: "profile", priority: 1, now: 1_000 });
  await queue.enqueueTask({ mode: "seasonal", cycleId: "cycle-a", aid: 1, kind: "profile", priority: 1, now: 1_000 });
  const run = operator.beginOrResumeRun("cycle-a", "runner-a", 1_000);

  const claimed = operator.claimNext(run.id, "runner-a", 1_000);
  assert.equal(claimed.task.aid, 1);
  operator.recordOutcome({ runId: run.id, taskId: claimed.task.id, owner: "runner-a", outcome: "completed", now: 2_000 });
  const empty = operator.claimNext(run.id, "runner-a", 3_000);
  assert.equal(empty.task, null);
  assert.equal(empty.run.state, "completed");
});

test("stops with exit code one after five consecutive system errors", async () => {
  const { queue, operator } = setup();
  for (let aid = 1; aid <= 5; aid += 1) {
    await queue.enqueueTask({ mode: "seasonal", cycleId: "cycle-a", aid, kind: "profile", priority: 1, now: 1_000 });
  }
  const run = operator.beginOrResumeRun("cycle-a", "runner-a", 1_000);
  let result;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const { task } = operator.claimNext(run.id, "runner-a", 1_000 + attempt);
    result = operator.recordOutcome({
      runId: run.id, taskId: task.id, owner: "runner-a", outcome: "upstream_error", now: 2_000 + attempt,
    });
    assert.equal(result.consecutiveErrors, attempt);
  }
  assert.deepEqual(result, { stopped: true, exitCode: 1, consecutiveErrors: 5 });
  assert.throws(() => operator.claimNext(run.id, "runner-a", 4_000), /active run not found/);
});

test("a non-system outcome resets the consecutive error counter", async () => {
  const { queue, operator } = setup();
  for (let aid = 1; aid <= 3; aid += 1) {
    await queue.enqueueTask({ mode: "seasonal", cycleId: "cycle-a", aid, kind: "profile", priority: 1, now: 1_000 });
  }
  const run = operator.beginOrResumeRun("cycle-a", "runner-a", 1_000);
  for (const [outcome, expected] of [["schema_error", 1], ["completed", 0], ["rate_limited", 1]] as const) {
    const { task } = operator.claimNext(run.id, "runner-a", 2_000);
    const result = operator.recordOutcome({ runId: run.id, taskId: task.id, owner: "runner-a", outcome, now: 2_000 });
    assert.equal(result.consecutiveErrors, expected);
  }
});

test("rejects an outcome after the five-minute task lease expires", async () => {
  const { queue, operator } = setup();
  await queue.enqueueTask({
    mode: "seasonal", cycleId: "cycle-a", aid: 60,
    kind: "profile", priority: 1, now: 1_000,
  });
  const run = operator.beginOrResumeRun("cycle-a", "runner-a", 1_000);
  const claimed = operator.claimNext(run.id, "runner-a", 1_000);
  assert.throws(() => operator.recordOutcome({
    runId: run.id,
    taskId: claimed.task.id,
    owner: "runner-a",
    outcome: "completed",
    now: 1_000 + 5 * 60_000,
  }), /leased task/);
});

test("records one outcome per lease attempt when a task is requeued in the same run", async () => {
  const { db, queue, operator } = setup();
  await queue.enqueueTask({ mode: "seasonal", cycleId: "cycle-a", aid: 63, kind: "profile", priority: 1, now: 1_000 });
  const run = operator.beginOrResumeRun("cycle-a", "runner-a", 1_000);
  const first = operator.claimNext(run.id, "runner-a", 1_000).task;
  operator.recordOutcome({ runId: run.id, taskId: first.id, owner: "runner-a", outcome: "skipped", now: 2_000 });
  assert.throws(() => operator.recordOutcome({
    runId: run.id, taskId: first.id, owner: "runner-a", outcome: "completed", now: 2_001,
  }), /leased task/);

  await queue.enqueueTask({ mode: "seasonal", cycleId: "cycle-a", aid: 63, kind: "profile", priority: 1, now: 3_000 });
  const second = operator.claimNext(run.id, "runner-a", 3_000).task;
  assert.equal(second.id, first.id);
  operator.recordOutcome({ runId: run.id, taskId: second.id, owner: "runner-a", outcome: "completed", now: 4_000 });

  assert.deepEqual(db.prepare(`SELECT attempt, outcome FROM scan_task_outcomes
    WHERE run_id = ? AND task_id = ? ORDER BY attempt`).all(run.id, first.id).map((row) => ({ ...row })), [
    { attempt: 1, outcome: "skipped" }, { attempt: 2, outcome: "completed" },
  ]);
});

test("upgrades the old outcome uniqueness without losing history", () => {
  const db = new DatabaseSync(":memory:");
  createSqliteSeasonalStore(db);
  db.exec(`CREATE TABLE scan_task_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, task_id INTEGER NOT NULL,
    outcome TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX idx_scan_task_outcomes_task ON scan_task_outcomes(run_id, task_id);
  INSERT INTO scan_task_outcomes (run_id, task_id, outcome, created_at) VALUES (1, 2, 'completed', 3);`);
  createSqliteSeasonalOperatorStore(db);
  assert.deepEqual({ ...db.prepare("SELECT attempt, outcome FROM scan_task_outcomes").get() },
    { attempt: 1, outcome: "completed" });
  const indexSql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_scan_task_outcomes_task_attempt'").get().sql;
  assert.match(indexSql, /run_id, task_id, attempt/);
});

test("keeps a resumed run active until its live lease can be reclaimed", async () => {
  const { queue, operator } = setup();
  await queue.enqueueTask({ mode: "seasonal", cycleId: "cycle-a", aid: 61, kind: "profile", priority: 1, now: 1_000 });
  const run = operator.beginOrResumeRun("cycle-a", "runner-a", 1_000);
  operator.claimNext(run.id, "runner-a", 1_000);
  const waiting = operator.claimNext(run.id, "runner-a", 2_000);
  assert.equal(waiting.run.state, "running");
  assert.equal(waiting.retryAt, 1_000 + 5 * 60_000);
  assert.equal(operator.beginOrResumeRun("cycle-a", "runner-a", 3_000).id, run.id);
  assert.equal(operator.claimNext(run.id, "runner-a", 1_000 + 5 * 60_000).task.aid, 61);
});

test("ban confirmation is bound to the active ban-check lease", async () => {
  const { db, queue, operator } = setup();
  db.prepare(`INSERT INTO player_profiles (
    mode, cycle_id, aid, nickname, profile_updated_at, last_access_at,
    experience, pmc_raids, scav_raids, pmc_survived, pmc_deaths, pmc_kills, killed_pmc,
    first_seen_at, last_seen_at
  ) VALUES ('seasonal', 'cycle-a', 62, 'Test', 1, 1, 0, 1, 0, 0, 1, 0, 0, 1, 1)`).run();
  await queue.enqueueTask({ mode: "seasonal", cycleId: "cycle-a", aid: 62, kind: "ban_check", priority: 1, now: 1_000 });
  const run = operator.beginOrResumeRun("cycle-a", "runner-a", 1_000);
  const { task } = operator.claimNext(run.id, "runner-a", 1_000);
  assert.throws(() => operator.confirmBanned({ runId: run.id, taskId: task.id, owner: "other", aid: 62, cycleId: "cycle-a" }));
  operator.confirmBanned({ runId: run.id, taskId: task.id, owner: "runner-a", aid: 62, cycleId: "cycle-a", now: 2_000 });
  assert.deepEqual({ ...db.prepare(`SELECT aid, mode, cycle_id, source, confirmed_at
    FROM upstream_ban_confirmations WHERE aid = 62`).get() }, {
    aid: 62, mode: "seasonal", cycle_id: "cycle-a", source: "seasonal_upstream", confirmed_at: 2_000,
  });
  assert.equal(db.prepare("SELECT confirmed_banned AS banned FROM player_profiles WHERE aid = 62").get().banned, 1);
});

test("operator status reports coverage and separate operational queues", async () => {
  const { db, queue, operator } = setup();
  db.prepare("INSERT INTO scan_members (mode, cycle_id, aid, joined_at, active) VALUES ('seasonal', 'cycle-a', 1, 1, 1)").run();
  await queue.enqueueTask({ mode: "seasonal", cycleId: "cycle-a", aid: 1, kind: "ban_check", priority: 1, now: 1_000 });
  await queue.enqueueTask({ mode: "seasonal", cycleId: "cycle-a", aid: 2, kind: "profile", priority: 2, now: 1_000 });

  const status = operator.status("cycle-a", 2_000);
  assert.deepEqual(status.coverage, { panel: 1, captured: 0 });
  assert.equal(status.stale.length, 2);
  assert.equal(status.community[0].aid, 2);
  assert.equal(status.banQueue[0].aid, 1);
});
