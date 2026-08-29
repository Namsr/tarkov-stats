import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error -- Node 24 exposes node:sqlite at runtime; project types target Node 20.
import { DatabaseSync } from "node:sqlite";
// @ts-expect-error -- Node's strip-types runner resolves the explicit .ts module.
import { createSqliteSeasonalOperatorStore, normalizeProgressionRefreshCandidates } from "../lib/seasonal/operator.ts";
// @ts-expect-error -- Node's strip-types runner resolves the explicit .ts module.
import { createD1SeasonalOperatorStore } from "../lib/seasonal/operator-d1.ts";
// @ts-expect-error -- Node's strip-types runner resolves the explicit .ts module.
import { initializeSeasonalSchema } from "../lib/seasonal/storage.ts";

class FakeD1Statement {
  private args: unknown[] = [];
  private readonly db: InstanceType<typeof DatabaseSync>;
  private readonly sql: string;
  constructor(db: InstanceType<typeof DatabaseSync>, sql: string) {
    this.db = db;
    this.sql = sql;
  }
  bind(...args: unknown[]) { this.args = args; return this; }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async run() {
    const result = this.db.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
}

class FakeD1 {
  private readonly db: InstanceType<typeof DatabaseSync>;
  constructor(db: InstanceType<typeof DatabaseSync>) { this.db = db; }
  prepare(sql: string) { return new FakeD1Statement(this.db, sql); }
  async exec(sql: string) { this.db.exec(sql); }
  async batch(statements: FakeD1Statement[]) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

test("Seasonal refresh restart caps one synchronized batch at 500 candidates", () => {
  const candidates = Array.from({ length: 500 }, (_, index) => ({ aid: index + 1, updatedAt: index + 1 }));
  assert.equal(normalizeProgressionRefreshCandidates(candidates).length, 500);
  assert.throws(
    () => normalizeProgressionRefreshCandidates([...candidates, { aid: 501, updatedAt: 501 }]),
    /too large/,
  );
});

test("Seasonal progression refresh restart replaces the active queue in upstream order", () => {
  const db = new DatabaseSync(":memory:");
  initializeSeasonalSchema(db);
  const store = createSqliteSeasonalOperatorStore(db);
  const restarted = store.restartProgressionRefreshRun("cycle-restart", "extension-test", [
    { aid: 303, updatedAt: 300 },
    { aid: 301, updatedAt: 100 },
    { aid: 303, updatedAt: 200 },
  ], 1_000);
  assert.equal(restarted.requested, 2);
  assert.equal(restarted.accepted, 2);
  const first = store.claimNextProgressionRefresh(restarted.run.id, "extension-test", 1_001);
  assert.equal(first.candidate?.aid, 301);
  const secondRestart = store.restartProgressionRefreshRun("cycle-restart", "extension-test", [
    { aid: 399, updatedAt: 50 },
  ], 1_002);
  assert.equal(secondRestart.run.id, restarted.run.id);
  const replacement = store.claimNextProgressionRefresh(secondRestart.run.id, "extension-test", 1_003);
  assert.equal(replacement.candidate?.aid, 399);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM seasonal_progression_refresh_candidates WHERE run_id = ?").get(restarted.run.id).n, 1);
});

test("D1 Seasonal progression refresh restart and release preserve the upstream queue", async () => {
  const db = new DatabaseSync(":memory:");
  initializeSeasonalSchema(db);
  const operator = createD1SeasonalOperatorStore(new FakeD1(db));
  const restarted = await operator.restartProgressionRefreshRun("cycle-d1-restart", "d1-test", [
    { aid: 402, updatedAt: 200 },
    { aid: 401, updatedAt: 100 },
  ], 100);
  const first = await operator.claimNextProgressionRefresh(restarted.run.id, "d1-test", 101);
  assert.equal(first.candidate?.aid, 401);
  const released = await operator.releaseProgressionRefreshLease({
    runId: restarted.run.id, candidateId: first.candidate!.id, aid: 401,
    cycleId: "cycle-d1-restart", owner: "d1-test", now: 102,
  });
  assert.equal(released.released, true);
  const again = await operator.claimNextProgressionRefresh(restarted.run.id, "d1-test", 103);
  assert.equal(again.candidate?.aid, 401);
});

test("Seasonal progression refresh freezes eligible active-cycle snapshots in oldest-latest order", () => {
  const db = new DatabaseSync(":memory:");
  initializeSeasonalSchema(db);
  db.exec(`
    INSERT INTO progression_snapshots
      (mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at, local_date)
    VALUES
      ('seasonal', 'cycle-a', 101, 100, 100, 1000, '2026-08-01'),
      ('seasonal', 'cycle-a', 101, 200, 200, 3000, '2026-08-02'),
      ('seasonal', 'cycle-a', 102, 150, 150, 2000, '2026-08-01'),
      ('seasonal', 'cycle-b', 103, 150, 150, 100, '2026-08-01'),
      ('regular', 'persistent', 104, 150, 150, 50, '2026-08-01')
  `);
  db.prepare("INSERT INTO excluded_players (aid, reason, created_at) VALUES (?, ?, ?)").run(105, "admin_manual", 1);
  db.prepare(`INSERT INTO progression_snapshots
    (mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at, local_date)
    VALUES ('seasonal', 'cycle-a', ?, ?, ?, ?, ?)`)
    .run(105, 100, 100, 4000, "2026-08-03");

  const store = createSqliteSeasonalOperatorStore(db);
  const started = store.beginOrResumeProgressionRefreshRun("cycle-a", "extension-test", 10_000);
  db.prepare(`INSERT INTO progression_snapshots
    (mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at, local_date)
    VALUES ('seasonal', 'cycle-a', 106, 100, 100, 1, '2026-08-01')`).run();

  const first = store.claimNextProgressionRefresh(started.run.id, "extension-test", 10_001);
  assert.equal(first.candidate?.aid, 102);
  assert.equal(first.remaining, 2);
  assert.ok(store.activeProgressionRefreshLease({
    runId: started.run.id, candidateId: first.candidate!.id, owner: "extension-test",
    aid: 102, cycleId: "cycle-a", now: 10_002,
  }));
  store.recordProgressionRefreshOutcome({
    runId: started.run.id, candidateId: first.candidate!.id, aid: 102,
    cycleId: "cycle-a", owner: "extension-test", outcome: "skipped", now: 10_003,
  });
  assert.equal(store.activeProgressionRefreshLease({
    runId: started.run.id, candidateId: first.candidate!.id, owner: "extension-test",
    aid: 102, cycleId: "cycle-a", now: 10_004,
  }), null);

  const second = store.claimNextProgressionRefresh(started.run.id, "extension-test", 10_005);
  assert.equal(second.candidate?.aid, 101);
  store.recordProgressionRefreshOutcome({
    runId: started.run.id, candidateId: second.candidate!.id, aid: 101,
    cycleId: "cycle-a", owner: "extension-test", outcome: "completed", now: 10_006,
  });
  const done = store.claimNextProgressionRefresh(started.run.id, "extension-test", 10_007);
  assert.equal(done.candidate, null);
  assert.equal(done.run.state, "completed");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM seasonal_progression_refresh_candidates WHERE run_id = ?").get(started.run.id).n, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM seasonal_progression_refresh_candidates WHERE run_id = ? AND aid = 106").get(started.run.id).n, 0);
});

test("D1 Seasonal progression refresh preserves the same frozen lease order", async () => {
  const db = new DatabaseSync(":memory:");
  initializeSeasonalSchema(db);
  db.exec(`INSERT INTO progression_snapshots
    (mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at, local_date)
    VALUES
      ('seasonal', 'cycle-d1', 201, 100, 100, 3000, '2026-08-01'),
      ('seasonal', 'cycle-d1', 202, 100, 100, 2000, '2026-08-01')`);
  const operator = createD1SeasonalOperatorStore(new FakeD1(db));
  const run = await operator.beginOrResumeProgressionRefreshRun("cycle-d1", "d1-test", 100);
  const first = await operator.claimNextProgressionRefresh(run.run.id, "d1-test", 101);
  assert.equal(first.candidate?.aid, 202);
  await operator.recordProgressionRefreshOutcome({
    runId: run.run.id, candidateId: first.candidate!.id, aid: 202,
    cycleId: "cycle-d1", owner: "d1-test", outcome: "completed", now: 102,
  });
  const second = await operator.claimNextProgressionRefresh(run.run.id, "d1-test", 103);
  assert.equal(second.candidate?.aid, 201);
});
