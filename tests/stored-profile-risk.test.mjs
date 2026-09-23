import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Execute the stored-profile scheduling block with the route's side effects stubbed.
const route = readFileSync(new URL("../app/api/player/profile/route.ts", import.meta.url), "utf8");
const start = route.indexOf("      const riskIsFresh = storedRisk &&", route.indexOf("  if (!force) {"));
const end = route.indexOf("      const publicRisk = toPublicRiskView(storedRisk", start);
assert.ok(start >= 0 && end > start);
const schedule = new Function("stored", "storedRisk", "after", "evaluateAndStoreRisk", "setTimeout", "aid", "cycleId", route.slice(start, end));

test("stored PvP profiles schedule only missing or stale risk after the response", async () => {
  const updatedAt = Date.now() - 60_000;
  const fresh = { profileUpdatedAt: updatedAt, evaluatedAt: Date.now() };
  for (const [risk, known, expected] of [
    [null, true, 1],
    [{ ...fresh, profileUpdatedAt: updatedAt - 1 }, true, 1],
    [{ ...fresh, evaluatedAt: Date.now() - 6 * 60 * 60 * 1000 }, true, 1],
    [fresh, true, 0],
    [null, false, 0],
  ]) {
    const stored = { stats: { pvpStatsKnown: known, profileUpdatedAt: updatedAt }, achievementIds: ["achievement"] };
    const callbacks = [];
    const evaluations = [];
    schedule(stored, risk, (fn) => callbacks.push(fn), async (input) => evaluations.push(input), (fn) => fn(), 3003626, "persistent");
    assert.equal(callbacks.length, expected);
    assert.equal(evaluations.length, 0);
    for (const callback of callbacks) await callback();
    assert.deepEqual(evaluations, expected ? [{ aid: 3003626, mode: "regular", cycleId: "persistent", ...stored }] : []);
  }
});
