/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- node:sqlite types are not present in the project's Node 20 type package.
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createSqliteSeasonalStore } from "../lib/seasonal/storage.ts";
import {
  allocateSeasonalPanel,
  allocateSeasonalPanelForAge,
  createSqliteScannerLifecycle,
  seasonalCandidateOrderKey,
} from "../lib/seasonal/scanner.ts";

const minute = 60_000;

test("claims by priority inside one mode/cycle scope", async () => {
  const store = createSqliteSeasonalStore(new DatabaseSync(":memory:"));
  const base = { mode: "seasonal", cycleId: "cycle-a", kind: "profile", now: 1_000 } as const;
  await store.enqueueTask({ ...base, aid: 4, priority: 4 });
  await store.enqueueTask({ ...base, aid: 2, priority: 2 });
  await store.enqueueTask({ ...base, aid: 1, priority: 1 });
  await store.enqueueTask({ ...base, cycleId: "cycle-b", aid: 99, priority: 1 });

  const claimed = await store.claimTasks({
    mode: "seasonal", cycleId: "cycle-a", actor: "operator", owner: "scanner-a", limit: 3, now: 1_000,
  });

  assert.deepEqual(claimed.map((task) => task.aid), [1, 2, 4]);
  assert.ok(claimed.every((task) => task.cycleId === "cycle-a"));
  assert.ok(claimed.every((task) => task.leasedUntil === 1_000 + 5 * minute));
});

test("does not double-claim a live lease and reclaims it after five minutes", async () => {
  const store = createSqliteSeasonalStore(new DatabaseSync(":memory:"));
  await store.enqueueTask({
    mode: "seasonal", cycleId: "cycle-a", aid: 42, kind: "profile", priority: 1, now: 10_000,
  });

  const first = await store.claimTasks({
    mode: "seasonal", cycleId: "cycle-a", actor: "helper", owner: "helper-a", limit: 1, now: 10_000,
  });
  assert.equal(first.length, 1);
  assert.equal((await store.claimTasks({
    mode: "seasonal", cycleId: "cycle-a", actor: "operator", owner: "operator-a", limit: 1,
    now: 10_000 + 5 * minute - 1,
  })).length, 0);

  const reclaimed = await store.claimTasks({
    mode: "seasonal", cycleId: "cycle-a", actor: "operator", owner: "operator-a", limit: 1,
    now: 10_000 + 5 * minute,
  });
  assert.equal(reclaimed[0].leaseOwner, "operator-a");
  assert.equal(reclaimed[0].attempts, 2);
});

test("keeps ban checks operator-only in the common queue", async () => {
  const store = createSqliteSeasonalStore(new DatabaseSync(":memory:"));
  await store.enqueueTask({
    mode: "seasonal", cycleId: "cycle-a", aid: 7, kind: "ban_check", priority: 1, now: 5_000,
  });

  assert.equal((await store.claimTasks({
    mode: "seasonal", cycleId: "cycle-a", actor: "helper", owner: "helper-a", limit: 1, now: 5_000,
  })).length, 0);
  const operatorClaim = await store.claimTasks({
    mode: "seasonal", cycleId: "cycle-a", actor: "operator", owner: "operator-a", limit: 1, now: 5_000,
  });
  assert.equal(operatorClaim[0].kind, "ban_check");
});

test("deduplicates queued work and promotes it to the highest priority", async () => {
  const store = createSqliteSeasonalStore(new DatabaseSync(":memory:"));
  const task = { mode: "seasonal", cycleId: "cycle-a", aid: 8, kind: "profile" } as const;
  await store.enqueueTask({ ...task, priority: 4, availableAt: 20_000, now: 1_000 });
  const promoted = await store.enqueueTask({ ...task, priority: 2, availableAt: 10_000, now: 2_000 });

  assert.equal(promoted.priority, 2);
  assert.equal(promoted.availableAt, 10_000);
});

test("rejects non-Seasonal tasks from the longitudinal queue", async () => {
  const store = createSqliteSeasonalStore(new DatabaseSync(":memory:"));
  await assert.rejects(() => store.enqueueTask({
    mode: "regular", cycleId: "persistent", aid: 1,
    kind: "profile", priority: 1,
  }), /seasonal queue/);
});

test("allocates 2,000 panel seats across all eight lifetime bands", () => {
  const allocation = allocateSeasonalPanel(Array(8).fill(1_000));
  assert.deepEqual(allocation, Array(8).fill(250));
  assert.equal(allocation.reduce((sum, value) => sum + value, 0), 2_000);
});

test("redistributes unavailable minimum seats without exceeding population", () => {
  const population = [50, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000];
  const allocation = allocateSeasonalPanel(population);
  assert.equal(allocation[0], 50);
  assert.ok(allocation.slice(1).every((value) => value >= 150));
  assert.ok(allocation.every((value, index) => value <= population[index]));
  assert.equal(allocation.reduce((sum, value) => sum + value, 0), 2_000);
});

test("reserves unavailable minimum seats until the 72-hour panel deadline", () => {
  const population = [50, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000];
  const before = allocateSeasonalPanelForAge(population, 72 * 60 * minute - 1);
  const after = allocateSeasonalPanelForAge(population, 72 * 60 * minute);
  assert.equal(before.reduce((sum, value) => sum + value, 0), 1_900);
  assert.equal(after.reduce((sum, value) => sum + value, 0), 2_000);
});

test("uses a stable cycle-specific order when the public index has no activity fields", () => {
  const first = [11, 12, 13, 14].map((aid) => [aid, seasonalCandidateOrderKey("cycle-a", aid)]);
  const repeat = [11, 12, 13, 14].map((aid) => [aid, seasonalCandidateOrderKey("cycle-a", aid)]);
  const other = [11, 12, 13, 14].map((aid) => [aid, seasonalCandidateOrderKey("cycle-b", aid)]);
  assert.deepEqual(first, repeat);
  assert.notDeepEqual(first, other);
  assert.equal(new Set(first.map((entry) => entry[1])).size, first.length);
});

test("capture lifecycle builds the panel and unlocks community progression after two changed intervals", async () => {
  const db = new DatabaseSync(":memory:");
  const store = createSqliteSeasonalStore(db);
  const lifecycle = createSqliteScannerLifecycle(db);
  const cycle = { mode: "seasonal", cycleId: "c1", startsAt: 1_000, endsAt: null,
    enabled: true, upstreamContract: "game_mode" } as const;
  const baseline = { mode: "seasonal", cycleId: "c1", aid: 7, nickname: "P",
    profileUpdatedAt: 2_000, lastAccessAt: 2_000, lifetimePvpHours: null,
    counters: { experience: 10, pmcRaids: 1, scavRaids: 0, pmcSurvived: 1,
      pmcDeaths: 0, pmcKills: 1, killedPmc: 1 } } as const;
  await store.upsertProfile(baseline, 2_000);
  const first = await store.captureSnapshot(baseline, 2_000);
  lifecycle.recordCapture(cycle, baseline, first, 125, 2_000);
  lifecycle.enqueueAfterProfileOpen(cycle, baseline.aid, 2_000);
  const firstRow = { ...db.prepare(`SELECT lifetime_pvp_hours, progression_eligible, snapshot_count
    FROM player_profiles WHERE mode = 'seasonal' AND cycle_id = 'c1' AND aid = 7`).get() };
  assert.deepEqual(firstRow, { lifetime_pvp_hours: 125, progression_eligible: 0, snapshot_count: 1 });
  assert.equal(db.prepare("SELECT priority FROM scan_tasks WHERE aid = 7 AND kind = 'profile'").get().priority, 3);
  assert.equal(db.prepare("SELECT lifetime_band FROM scan_members WHERE aid = 7").get().lifetime_band, 2);

  const unchanged = { ...baseline, profileUpdatedAt: 3_000 };
  await store.upsertProfile(unchanged, 3_000);
  const duplicateCounters = await store.captureSnapshot(unchanged, 3_000);
  lifecycle.recordCapture(cycle, unchanged, duplicateCounters, 999, 3_000);
  assert.equal(db.prepare(`SELECT progression_eligible FROM player_profiles
    WHERE mode = 'seasonal' AND cycle_id = 'c1' AND aid = 7`).get().progression_eligible, 0);

  const progressed = { ...baseline, profileUpdatedAt: 4_000,
    counters: { ...baseline.counters, experience: 20, pmcRaids: 2 } };
  await store.upsertProfile(progressed, 4_000);
  const second = await store.captureSnapshot(progressed, 4_000);
  lifecycle.recordCapture(cycle, progressed, second, 999, 4_000);
  const secondRow = { ...db.prepare(`SELECT lifetime_pvp_hours, progression_eligible, snapshot_count
    FROM player_profiles WHERE mode = 'seasonal' AND cycle_id = 'c1' AND aid = 7`).get() };
  assert.deepEqual(secondRow, { lifetime_pvp_hours: 125, progression_eligible: 0, snapshot_count: 3 });

  const progressedAgain = { ...progressed, profileUpdatedAt: 5_000,
    counters: { ...progressed.counters, experience: 30, pmcRaids: 3 } };
  await store.upsertProfile(progressedAgain, 5_000);
  const third = await store.captureSnapshot(progressedAgain, 5_000);
  lifecycle.recordCapture(cycle, progressedAgain, third, 999, 5_000);
  const thirdRow = { ...db.prepare(`SELECT lifetime_pvp_hours, progression_eligible, snapshot_count
    FROM player_profiles WHERE mode = 'seasonal' AND cycle_id = 'c1' AND aid = 7`).get() };
  assert.deepEqual(thirdRow, { lifetime_pvp_hours: 125, progression_eligible: 1, snapshot_count: 4 });
});

test("daily Seasonal requeue assigns the four lifecycle priorities once per Moscow date", async () => {
  const db = new DatabaseSync(":memory:");
  const store = createSqliteSeasonalStore(db);
  const lifecycle = createSqliteScannerLifecycle(db);
  const start = Date.parse("2026-01-01T00:00:00+03:00");
  const cycle = { mode: "seasonal", cycleId: "c1", startsAt: start, endsAt: null,
    enabled: true, upstreamContract: "game_mode" } as const;
  const make = async (aid: number, snapshots: number) => {
    let profile = { mode: "seasonal" as const, cycleId: "c1", aid, nickname: `P${aid}`,
      profileUpdatedAt: start + aid, lastAccessAt: start + aid, lifetimePvpHours: 100,
      counters: { experience: aid, pmcRaids: 1, scavRaids: 0, pmcSurvived: 1,
        pmcDeaths: 0, pmcKills: 1, killedPmc: 1 } };
    await store.upsertProfile(profile, start);
    await store.captureSnapshot(profile, start);
    if (snapshots === 2) {
      profile = { ...profile, profileUpdatedAt: start + 10_000 + aid,
        counters: { ...profile.counters, experience: aid + 10 } };
      await store.upsertProfile(profile, start);
      await store.captureSnapshot(profile, start);
    }
  };
  await make(1, 1);
  await make(2, 2);
  await make(3, 1);
  db.prepare(`INSERT INTO scan_members (mode, cycle_id, aid, lifetime_band, joined_at, active)
    VALUES ('seasonal', 'c1', 1, 2, ?, 1)`).run(start);
  lifecycle.recordCandidate({ cycleId: "c1", aid: 4, nickname: "P4", trustedHours: 100, now: start });
  db.prepare("DELETE FROM scan_tasks").run();
  const nextDay = start + 86_400_000;
  assert.equal(lifecycle.requeueDaily(cycle, nextDay), true);
  assert.deepEqual(db.prepare("SELECT aid, priority FROM scan_tasks ORDER BY priority, aid").all().map((row) => ({ ...row })), [
    { aid: 1, priority: 1 }, { aid: 2, priority: 2 }, { aid: 3, priority: 3 }, { aid: 4, priority: 4 },
  ]);
  assert.equal(lifecycle.requeueDaily(cycle, nextDay + 1_000), false);
});

test("linked PvP fixes hours once and only then releases the Seasonal follow-up", async () => {
  const db = new DatabaseSync(":memory:");
  const store = createSqliteSeasonalStore(db);
  const lifecycle = createSqliteScannerLifecycle(db);
  const cycle = { mode: "seasonal", cycleId: "c1", startsAt: 1_000, endsAt: null,
    enabled: true, upstreamContract: "game_mode" } as const;
  const profile = { mode: "seasonal" as const, cycleId: "c1", aid: 9, nickname: "P9",
    profileUpdatedAt: 2_000, lastAccessAt: 2_000, lifetimePvpHours: null,
    counters: { experience: 10, pmcRaids: 1, scavRaids: 0, pmcSurvived: 1,
      pmcDeaths: 0, pmcKills: 1, killedPmc: 1 } };
  await store.upsertProfile(profile, 2_000);
  await store.captureSnapshot(profile, 2_000);
  lifecycle.recordCandidate({ cycleId: "c1", aid: 9, nickname: "P9", trustedHours: null, now: 2_000 });
  const linked = db.prepare("SELECT id FROM scan_tasks WHERE aid = 9 AND kind = 'linked_pvp'").get();
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM scan_tasks WHERE aid = 9 AND kind = 'profile'").get().n, 0);
  lifecycle.recordLinkedPvp(cycle, 9, 250, 3_000);
  lifecycle.recordLinkedPvp(cycle, 9, 999, 4_000);
  db.prepare("UPDATE scan_tasks SET state = 'completed' WHERE id = ?").run(linked.id);
  lifecycle.finalizeTask(cycle, linked.id, 4_000);
  assert.equal(db.prepare("SELECT lifetime_pvp_hours FROM player_profiles WHERE aid = 9").get().lifetime_pvp_hours, 250);
  assert.deepEqual({ ...db.prepare("SELECT kind, priority FROM scan_tasks WHERE aid = 9 AND kind = 'profile'").get() },
    { kind: "profile", priority: 3 });
});

test("an unchanged profile follow-up is not immediately requeued", async () => {
  const db = new DatabaseSync(":memory:");
  const store = createSqliteSeasonalStore(db);
  const lifecycle = createSqliteScannerLifecycle(db);
  const cycle = { mode: "seasonal", cycleId: "c1", startsAt: 1_000, endsAt: null,
    enabled: true, upstreamContract: "game_mode" } as const;
  const baseline = { mode: "seasonal" as const, cycleId: "c1", aid: 10, nickname: "P10",
    profileUpdatedAt: 2_000, lastAccessAt: 2_000, lifetimePvpHours: 100,
    counters: { experience: 10, pmcRaids: 1, scavRaids: 0, pmcSurvived: 1,
      pmcDeaths: 0, pmcKills: 1, killedPmc: 1 } };
  await store.upsertProfile(baseline, 2_000);
  await store.captureSnapshot(baseline, 2_000);
  await store.enqueueTask({ mode: "seasonal", cycleId: "c1", aid: 10, kind: "profile", priority: 3,
    previousProfileUpdatedAt: 2_000, now: 3_000 });
  const task = db.prepare("SELECT id FROM scan_tasks WHERE aid = 10 AND kind = 'profile'").get();
  db.prepare("UPDATE scan_tasks SET state = 'completed' WHERE id = ?").run(task.id);
  lifecycle.finalizeTask(cycle, task.id, 3_000);
  assert.equal(db.prepare("SELECT state FROM scan_tasks WHERE id = ?").get(task.id).state, "completed");
});
