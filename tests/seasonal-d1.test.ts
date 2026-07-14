/* eslint-disable @typescript-eslint/ban-ts-comment */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
// @ts-ignore -- Node 24 exposes node:sqlite at runtime; project types target Node 20.
import { DatabaseSync } from "node:sqlite";
// @ts-ignore -- direct Node TypeScript tests require explicit extensions.
import { createD1SeasonalStore, upsertD1SeasonCycle } from "../lib/seasonal/storage-d1.ts";
// @ts-ignore -- direct Node TypeScript tests require explicit extensions.
import { initializeSeasonalSchema, SEASONAL_SCHEMA, createSqliteSeasonalStore } from "../lib/seasonal/storage.ts";
// @ts-ignore -- direct Node TypeScript tests require explicit extensions.
import { refreshD1SeasonalAggregates, refreshSqliteSeasonalAggregates } from "../lib/seasonal/daily-aggregates.ts";
// @ts-ignore -- direct Node TypeScript tests require explicit extensions.
import { createD1SeasonalOperatorStore } from "../lib/seasonal/operator-d1.ts";
// @ts-ignore -- direct Node TypeScript tests require explicit extensions.
import { createD1ScannerLifecycle } from "../lib/seasonal/scanner-d1.ts";

class FakeStatement {
  args: unknown[] = [];
  private db: DatabaseSync;
  sql: string;
  constructor(db: DatabaseSync, sql: string) { this.db = db; this.sql = sql; }
  bind(...args: unknown[]) { this.args = args; return this; }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  async run() {
    const result = this.db.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
}

class FakeD1 {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }
  prepare(sql: string) { return new FakeStatement(this.db, sql); }
  async batch(statements: FakeStatement[]) {
    const results = [];
    for (const statement of statements) {
      const trimmed = (statement as unknown as { sql: string }).sql;
      results.push(/^\s*(SELECT|WITH\s+ranked\s+AS\s*\(\s*SELECT)/i.test(trimmed)
        ? await statement.all() : await statement.run());
    }
    return results;
  }
}

function profile(aid: number, updated: number, experience: number, raids: number) {
  return {
    mode: "seasonal" as const, cycleId: "s1", aid, nickname: `p${aid}`,
    profileUpdatedAt: updated, lastAccessAt: updated, lifetimePvpHours: aid * 100,
    counters: { experience, pmcRaids: raids, scavRaids: 0, pmcSurvived: raids,
      pmcDeaths: 0, pmcKills: raids * 2, killedPmc: raids },
    staticSignals: { prestige: 2, longestWinStreak: 9, achievementIds: ["d1-ach"] },
  };
}

test("D1 migration creates every Seasonal backend table", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync("scripts/seasonal-storage-d1.sql", "utf8"));
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name));
  for (const name of ["season_cycles", "player_profiles", "progression_snapshots", "progression_intervals",
    "daily_aggregates", "scan_cohorts", "scan_candidates", "scan_discovery_state", "scan_daily_requeues",
    "scan_members", "scan_tasks", "scan_runs", "scan_task_outcomes", "helper_sessions"]) {
    assert.ok(tables.has(name), `missing ${name}`);
  }
  const columns = new Set((db.prepare("PRAGMA table_info(player_profiles)").all() as { name: string }[]).map((row) => row.name));
  assert.ok(columns.has("progression_eligible"));
  const outcomeColumns = new Set((db.prepare("PRAGMA table_info(scan_task_outcomes)").all() as { name: string }[]).map((row) => row.name));
  assert.ok(outcomeColumns.has("attempt"));
});

test("deployed D1 outcome upgrade preserves history and replaces attempt uniqueness", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`${SEASONAL_SCHEMA}
    CREATE TABLE scan_task_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, task_id INTEGER NOT NULL,
      outcome TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_scan_task_outcomes_task ON scan_task_outcomes(run_id, task_id);
    INSERT INTO scan_task_outcomes (run_id, task_id, outcome, created_at) VALUES (1, 2, 'completed', 3);
    INSERT INTO player_profiles (mode, cycle_id, aid, nickname, profile_updated_at, last_access_at,
      experience, pmc_raids, scav_raids, pmc_survived, pmc_deaths, pmc_kills, killed_pmc,
      first_seen_at, last_seen_at, progression_eligible) VALUES
      ('seasonal', 's1', 10, 'one-change', 3, 3, 30, 3, 0, 3, 0, 6, 3, 1, 3, 1),
      ('seasonal', 's1', 20, 'two-changes', 3, 3, 30, 3, 0, 3, 0, 6, 3, 1, 3, 0);
    INSERT INTO progression_intervals (mode, cycle_id, aid, from_snapshot_id, to_snapshot_id,
      ended_at, local_date, elapsed_days, status, experience, pmc_raids, scav_raids,
      pmc_survived, pmc_deaths, pmc_kills, killed_pmc) VALUES
      ('seasonal', 's1', 10, 1, 2, 2, '2026-01-02', 1, 'valid', 10, 1, 0, 1, 0, 2, 1),
      ('seasonal', 's1', 20, 3, 4, 2, '2026-01-02', 1, 'valid', 10, 1, 0, 1, 0, 2, 1),
      ('seasonal', 's1', 20, 4, 5, 3, '2026-01-03', 1, 'valid', 10, 1, 0, 1, 0, 2, 1);`);
  db.exec(readFileSync("scripts/seasonal-scanner-correctness-d1.sql", "utf8"));
  assert.deepEqual({ ...db.prepare("SELECT attempt, outcome FROM scan_task_outcomes").get() },
    { attempt: 1, outcome: "completed" });
  assert.match(String(db.prepare(`SELECT sql FROM sqlite_master
    WHERE name = 'idx_scan_task_outcomes_task_attempt'`).get().sql), /run_id, task_id, attempt/);
  assert.deepEqual(db.prepare("SELECT aid, progression_eligible FROM player_profiles ORDER BY aid").all()
    .map((row: Record<string, unknown>) => ({ ...row })), [
    { aid: 10, progression_eligible: 0 }, { aid: 20, progression_eligible: 1 },
  ]);
});

test("D1 Seasonal store bootstraps cycles, captures an ordered chain, and leases tasks", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SEASONAL_SCHEMA);
  const d1 = new FakeD1(sqlite);
  const store = createD1SeasonalStore(d1);
  await upsertD1SeasonCycle(d1, { mode: "seasonal", cycleId: "s1", startsAt: 1, endsAt: null, enabled: true, upstreamContract: "game_mode" });
  assert.equal((await store.getCycle("s1"))?.enabled, true);

  await store.upsertProfile(profile(1, 1000, 10, 1));
  assert.equal((await store.captureSnapshot(profile(1, 1000, 10, 1), 1000)).status, "baseline");
  await store.upsertProfile(profile(1, 3000, 30, 3));
  assert.equal((await store.captureSnapshot(profile(1, 3000, 30, 3), 3000)).status, "progression");
  assert.equal((await store.captureSnapshot(profile(1, 2000, 20, 2), 2000)).status, "stale");
  assert.deepEqual((await store.snapshotHistory({ mode: "seasonal", cycleId: "s1", aid: 1 })).map((row) => row.profileUpdatedAt), [1000, 3000]);
  assert.deepEqual({ ...sqlite.prepare(`SELECT prestige, longest_win_streak, achievements
    FROM progression_snapshots WHERE mode = 'seasonal' AND cycle_id = 's1' AND aid = 1
    ORDER BY profile_updated_at DESC LIMIT 1`).get() },
  { prestige: 2, longest_win_streak: 9, achievements: '["d1-ach"]' });

  await store.enqueueTask({ mode: "seasonal", cycleId: "s1", aid: 1, kind: "profile", priority: 2, now: 10 });
  const claimed = await store.claimTasks({ mode: "seasonal", cycleId: "s1", actor: "helper", owner: "h1", limit: 1, now: 10 });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].leaseOwner, "h1");
});

test("daily materialization populates Tempo/Form scores and physical aggregate rows", async () => {
  const db = new DatabaseSync(":memory:");
  initializeSeasonalSchema(db);
  const store = createSqliteSeasonalStore(db);
  for (const aid of [1, 2]) {
    const first = profile(aid, Date.parse("2026-07-01T12:00:00Z"), 100 * aid, aid);
    const second = profile(aid, Date.parse("2026-07-02T12:00:00Z"), 1000 * aid, aid + 5);
    await store.upsertProfile(first); await store.captureSnapshot(first);
    await store.upsertProfile(second); await store.captureSnapshot(second);
  }
  db.prepare("UPDATE player_profiles SET progression_eligible = 1 WHERE mode = 'seasonal' AND cycle_id = 's1'").run();
  const result = refreshSqliteSeasonalAggregates(db, "s1");
  assert.equal(result.intervals, 2);
  assert.ok(result.aggregates > 0);
  const scores = db.prepare("SELECT tempo_score, form_score FROM progression_intervals ORDER BY aid").all() as { tempo_score: number | null; form_score: number | null }[];
  assert.ok(scores.every((row) => row.tempo_score != null && row.form_score != null));
  const kinds = db.prepare("SELECT DISTINCT kind FROM daily_aggregates ORDER BY kind").all().map((row: unknown) => String((row as { kind: string }).kind));
  assert.deepEqual(kinds, ["cumulative", "form", "tempo"]);
});

test("SQLite Tempo includes any changed cumulative counter while Form requires PMC raids", async () => {
  const db = new DatabaseSync(":memory:");
  const store = createSqliteSeasonalStore(db);
  const first = profile(5, Date.parse("2026-07-01T12:00:00Z"), 100, 1);
  const second = { ...first, profileUpdatedAt: Date.parse("2026-07-02T12:00:00Z"),
    lastAccessAt: Date.parse("2026-07-02T12:00:00Z"),
    counters: { ...first.counters, scavRaids: 1 } };
  await store.upsertProfile(first); await store.captureSnapshot(first);
  await store.upsertProfile(second); await store.captureSnapshot(second);
  db.prepare("UPDATE player_profiles SET progression_eligible = 1 WHERE aid = 5").run();
  refreshSqliteSeasonalAggregates(db, "s1");
  assert.deepEqual({ ...db.prepare("SELECT tempo_score, form_score FROM progression_intervals").get() },
    { tempo_score: 50, form_score: null });
});

test("D1 Tempo includes any changed cumulative counter while Form requires PMC raids", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("scripts/seasonal-storage-d1.sql", "utf8"));
  const d1 = new FakeD1(sqlite);
  const store = createD1SeasonalStore(d1);
  const first = profile(6, Date.parse("2026-07-01T12:00:00Z"), 100, 1);
  const second = { ...first, profileUpdatedAt: Date.parse("2026-07-02T12:00:00Z"),
    lastAccessAt: Date.parse("2026-07-02T12:00:00Z"),
    counters: { ...first.counters, scavRaids: 1 } };
  await store.upsertProfile(first); await store.captureSnapshot(first);
  await store.upsertProfile(second); await store.captureSnapshot(second);
  sqlite.prepare("UPDATE player_profiles SET progression_eligible = 1 WHERE aid = 6").run();
  await refreshD1SeasonalAggregates(d1, "s1");
  assert.deepEqual({ ...sqlite.prepare("SELECT tempo_score, form_score FROM progression_intervals").get() },
    { tempo_score: 50, form_score: null });
});

test("D1 operator resumes, leases, and records outcomes in one cycle", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`${SEASONAL_SCHEMA}
    CREATE TABLE scan_task_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, task_id INTEGER NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1, outcome TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL
    );`);
  const d1 = new FakeD1(sqlite);
  const queue = createD1SeasonalStore(d1);
  await queue.enqueueTask({ mode: "seasonal", cycleId: "s1", aid: 7, kind: "profile", priority: 1, now: 10 });
  const operator = createD1SeasonalOperatorStore(d1);
  const run = await operator.beginOrResumeRun("s1", "runner", 10);
  const claimed = await operator.claimNext(run.id, "runner", 10);
  const task = claimed.task as { id: number };
  assert.ok(task.id > 0);
  const outcome = await operator.recordOutcome({ runId: run.id, taskId: task.id, owner: "runner", outcome: "completed", now: 11 });
  assert.equal(outcome.consecutiveErrors, 0);
  await assert.rejects(operator.recordOutcome({
    runId: run.id, taskId: task.id, owner: "runner", outcome: "completed", now: 12,
  }), /leased task/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM scan_task_outcomes").get().n, 1);
  assert.equal((await operator.beginOrResumeRun("s1", "runner", 12)).resumed, true);

  await queue.enqueueTask({ mode: "seasonal", cycleId: "s1", aid: 7, kind: "profile", priority: 1, now: 13 });
  const reclaimed = await operator.claimNext(run.id, "runner", 13) as { task: { id: number } };
  await operator.recordOutcome({ runId: run.id, taskId: reclaimed.task.id, owner: "runner", outcome: "skipped", now: 14 });
  assert.deepEqual(sqlite.prepare("SELECT attempt, outcome FROM scan_task_outcomes ORDER BY attempt").all()
    .map((row: Record<string, unknown>) => ({ ...row })), [
    { attempt: 1, outcome: "completed" }, { attempt: 2, outcome: "skipped" },
  ]);
});

test("D1 scanner lifecycle builds panel eligibility and completes linked-PvP follow-up", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync("scripts/seasonal-storage-d1.sql", "utf8"));
  const d1 = new FakeD1(sqlite);
  const store = createD1SeasonalStore(d1);
  const lifecycle = createD1ScannerLifecycle(d1);
  const cycle = { mode: "seasonal" as const, cycleId: "s1", startsAt: 1_000, endsAt: null,
    enabled: true, upstreamContract: "game_mode" as const };
  const first = { ...profile(7, 2_000, 10, 1), lifetimePvpHours: null };
  await store.upsertProfile(first, 2_000);
  const baseline = await store.captureSnapshot(first, 2_000);
  await lifecycle.recordCapture(cycle, first, baseline, 125, 2_000);
  assert.deepEqual({ ...sqlite.prepare(`SELECT lifetime_pvp_hours, progression_eligible
    FROM player_profiles WHERE aid = 7`).get() }, { lifetime_pvp_hours: 125, progression_eligible: 0 });
  assert.equal(sqlite.prepare("SELECT lifetime_band FROM scan_members WHERE aid = 7").get().lifetime_band, 2);

  await store.enqueueTask({ mode: "seasonal", cycleId: "s1", aid: 7, kind: "profile", priority: 3,
    previousProfileUpdatedAt: 2_000, now: 2_500 });
  const unchangedTask = sqlite.prepare("SELECT id FROM scan_tasks WHERE aid = 7 AND kind = 'profile'").get() as { id: number };
  sqlite.prepare("UPDATE scan_tasks SET state = 'completed' WHERE id = ?").run(unchangedTask.id);
  await lifecycle.finalizeTask(cycle, unchangedTask.id, 2_500);
  assert.equal(sqlite.prepare("SELECT state FROM scan_tasks WHERE id = ?").get(unchangedTask.id).state, "completed");

  const sameCounters = { ...first, profileUpdatedAt: 3_000, lastAccessAt: 3_000 };
  await store.upsertProfile(sameCounters, 3_000);
  const unchanged = await store.captureSnapshot(sameCounters, 3_000);
  await lifecycle.recordCapture(cycle, sameCounters, unchanged, 999, 3_000);
  assert.equal(sqlite.prepare("SELECT progression_eligible FROM player_profiles WHERE aid = 7").get().progression_eligible, 0);

  const second = { ...profile(7, 4_000, 20, 2), lifetimePvpHours: null };
  await store.upsertProfile(second, 4_000);
  const progressed = await store.captureSnapshot(second, 4_000);
  await lifecycle.recordCapture(cycle, second, progressed, 999, 4_000);
  assert.equal(sqlite.prepare("SELECT progression_eligible FROM player_profiles WHERE aid = 7").get().progression_eligible, 0);

  const third = { ...profile(7, 5_000, 30, 3), lifetimePvpHours: null };
  await store.upsertProfile(third, 5_000);
  const progressedAgain = await store.captureSnapshot(third, 5_000);
  await lifecycle.recordCapture(cycle, third, progressedAgain, 999, 5_000);
  assert.equal(sqlite.prepare("SELECT progression_eligible FROM player_profiles WHERE aid = 7").get().progression_eligible, 1);

  await lifecycle.recordCandidate({ cycleId: "s1", aid: 9, nickname: "P9", trustedHours: null, now: 4_000 });
  const linked = sqlite.prepare("SELECT id FROM scan_tasks WHERE aid = 9 AND kind = 'linked_pvp'").get() as { id: number };
  await lifecycle.recordLinkedPvp(cycle, 9, 250, 5_000);
  sqlite.prepare("UPDATE scan_tasks SET state = 'completed' WHERE id = ?").run(linked.id);
  await lifecycle.finalizeTask(cycle, linked.id, 5_000);
  assert.deepEqual({ ...sqlite.prepare("SELECT kind, priority FROM scan_tasks WHERE aid = 9 AND kind = 'profile'").get() },
    { kind: "profile", priority: 4 });

  await lifecycle.advanceDiscovery("s1", { orderKey: 42, aid: 9 }, 6_000);
  assert.deepEqual({ ...await lifecycle.discoveryState("s1") }, { cursor_key: 42, cursor_aid: 9, exhausted: 0 });
});
