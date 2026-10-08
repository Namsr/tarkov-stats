import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Execute the stored-profile scheduling block with the route's side effects stubbed.
// Anchored on the regular branch's own store read, since the pve branch has a
// block with the same shape.
const route = readFileSync(new URL("../app/api/player/profile/route.ts", import.meta.url), "utf8");
const regularRoot = route.indexOf("const storedStarted = timing.now();");
const start = route.indexOf("const riskIsFresh = storedRisk &&", regularRoot);
const end = route.indexOf("const publicRisk = riskIsFresh", start);
assert.ok(regularRoot >= 0 && start > regularRoot && end > start);
const schedule = new Function("snapshot", "storedRisk", "after", "evaluateRegularRiskInBackground", "setTimeout", "aid", "cycleId", "riskScoreVersion", route.slice(start, end));

test("stored PvP profiles schedule only missing or stale risk after the response", async () => {
  const updatedAt = Date.now() - 60_000;
  const fresh = { profileUpdatedAt: updatedAt, evaluatedAt: Date.now(), scoreVersion: 3, profileParserVersion: 2 };
  for (const [risk, known, expected] of [
    [null, true, 1],
    [{ ...fresh, profileUpdatedAt: updatedAt - 1 }, true, 1],
    [{ ...fresh, evaluatedAt: Date.now() - 6 * 60 * 60 * 1000 }, true, 1],
    [{ ...fresh, scoreVersion: 1 }, true, 1],
    [fresh, true, 0],
    [null, false, 1],
    [{ ...fresh, profileParserVersion: 1 }, false, 1],
    [fresh, false, 0],
  ]) {
    const stored = { stats: { pvpStatsKnown: known, profileUpdatedAt: updatedAt, pvpStatsParserVersion: 2 }, achievementIds: ["achievement"] };
    const callbacks = [];
    const evaluations = [];
    schedule(stored, risk, (fn) => callbacks.push(fn), async (input) => evaluations.push(input), (fn) => fn(), 3003626, "persistent", () => 3);
    assert.equal(callbacks.length, expected);
    assert.equal(evaluations.length, 0);
    for (const callback of callbacks) await callback();
    assert.deepEqual(evaluations, expected ? [{ aid: 3003626, mode: "regular", cycleId: "persistent", ...stored }] : []);
  }
});
