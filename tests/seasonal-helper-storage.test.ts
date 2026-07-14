/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- node:sqlite types are not present in the project's Node 20 types.
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createSqliteHelperStore } from "../lib/seasonal/helper-storage.ts";
import { createSqliteSeasonalStore } from "../lib/seasonal/storage.ts";

test("persists a three-minute helper polling window", () => {
  const helper = createSqliteHelperStore(new DatabaseSync(":memory:"));
  assert.equal(helper.touchSession("helper-a", 1_000), 181_000);
  assert.equal(helper.getSession("helper-a")?.polling_until, 181_000);
});

test("only the active lease owner can skip and helper leases cannot consume ban checks", async () => {
  const db = new DatabaseSync(":memory:");
  const helper = createSqliteHelperStore(db);
  const seasonal = createSqliteSeasonalStore(db);
  await seasonal.enqueueTask({ mode: "seasonal", cycleId: "c1", aid: 7, kind: "profile", priority: 1, now: 1_000 });
  await seasonal.enqueueTask({ mode: "seasonal", cycleId: "c1", aid: 8, kind: "ban_check", priority: 1, now: 1_000 });
  const [lease] = await seasonal.claimTasks({ mode: "seasonal", cycleId: "c1", actor: "helper", owner: "helper-a", limit: 3, now: 1_000 });
  assert.equal(lease.aid, 7);
  assert.equal(helper.getActiveLease(lease.id, "forged-owner", "c1", 2_000), null);
  assert.equal(helper.getActiveLease(lease.id, "helper-a", "forged-cycle", 2_000), null);
  assert.equal(helper.getActiveLease(lease.id, "helper-a", "c1", 2_000)?.aid, 7);
  assert.equal(helper.getActiveLease(lease.id, "helper-a", "c1", lease.leasedUntil!), null);
  assert.equal(helper.finish(lease.id, "forged-owner", "skipped", 2_000), false);
  assert.equal(helper.finish(lease.id, "helper-a", "skipped", lease.leasedUntil!), false);
  assert.equal(helper.finish(lease.id, "helper-a", "skipped", 2_000), true);
  assert.equal(helper.getTask(lease.id)?.state, "skipped");
});

test("snapshot remains idempotent when lease completion loses an expiry race", async () => {
  const db = new DatabaseSync(":memory:");
  const helper = createSqliteHelperStore(db);
  const seasonal = createSqliteSeasonalStore(db);
  const profile = {
    mode: "seasonal" as const, cycleId: "c1", aid: 7, nickname: "P",
    profileUpdatedAt: 2_000, lastAccessAt: 2_000, lifetimePvpHours: null,
    counters: { experience: 10, pmcRaids: 1, scavRaids: 0, pmcSurvived: 1, pmcDeaths: 0, pmcKills: 1, killedPmc: 1 },
  };
  await seasonal.enqueueTask({ mode: "seasonal", cycleId: "c1", aid: 7, kind: "profile", priority: 1, now: 1_000 });
  const [first] = await seasonal.claimTasks({ mode: "seasonal", cycleId: "c1", actor: "helper", owner: "helper-a", limit: 1, now: 1_000 });
  await seasonal.upsertProfile(profile, 2_000);
  assert.equal((await seasonal.captureSnapshot(profile, 2_000)).status, "baseline");
  assert.equal(helper.finish(first.id, "helper-a", "completed", first.leasedUntil! + 1), false);

  const [retry] = await seasonal.claimTasks({ mode: "seasonal", cycleId: "c1", actor: "helper", owner: "helper-b", limit: 1, now: first.leasedUntil! + 1 });
  assert.equal(retry.id, first.id);
  assert.equal((await seasonal.captureSnapshot(profile, 2_001)).status, "duplicate");
  assert.equal(helper.finish(retry.id, "helper-b", "completed", first.leasedUntil! + 2), true);
  assert.equal((await seasonal.snapshotHistory({ mode: "seasonal", cycleId: "c1", aid: 7 })).length, 1);
});
