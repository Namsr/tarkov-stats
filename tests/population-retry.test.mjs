import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { initializeSeasonalSchema } from "../lib/seasonal/storage.ts";
import { materializeDuePopulations, retryIntervalMs } from "../scripts/materialize-progression-population.mjs";

test("failed population retries every 15 minutes, preserves old data and skips successful scopes", () => {
  const db = new DatabaseSync(":memory:");
  initializeSeasonalSchema(db);
  assert.equal(retryIntervalMs, 900_000);
  const scopes = [{ mode: "regular", cycleId: "persistent" }, { mode: "seasonal", cycleId: "s1" }];
  const now = 30_000_000;
  const calls = [];
  let fail = true;
  const refresh = (_db, mode) => { calls.push(mode); if (mode === "regular" && fail) throw new Error("busy"); };
  const publish = (db, mode, cycle, now) => {
    db.prepare("INSERT OR REPLACE INTO progression_population_current VALUES (?, ?, ?, ?)").run(mode, cycle, now, now);
    return { generation: now, generatedAt: now };
  };
  publish(db, "regular", "persistent", 1);
  let result = materializeDuePopulations(db, scopes, { now, refresh, publish });
  assert.equal(result.errors.length, 1);
  assert.equal(result.published.length, 1);
  assert.equal(db.prepare("SELECT generation FROM progression_population_current WHERE mode = 'regular'").get().generation, 1);
  fail = false;
  result = materializeDuePopulations(db, scopes, { now: now + retryIntervalMs, refresh, publish });
  assert.equal(result.errors.length, 0);
  assert.deepEqual(calls, ["regular", "seasonal", "regular"]);
  result = materializeDuePopulations(db, scopes, { now: now + 2 * retryIntervalMs, refresh, publish });
  assert.equal(result.published.length, 0);
  assert.equal(calls.length, 3);
  db.close();
});
