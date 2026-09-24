import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { riskScoreVersion, storedRiskRefreshPolicy } from "../lib/admin/risk-version.ts";

// Execute the stored-profile scheduling block with the route's side effects stubbed.
const route = readFileSync(new URL("../app/api/player/profile/route.ts", import.meta.url), "utf8");
const start = route.indexOf("      const riskIsFresh = storedRisk &&", route.indexOf("  if (!force) {"));
const end = route.indexOf("      const publicRisk = storedRisk?.scoreVersion", start);
assert.ok(start >= 0 && end > start);
const schedule = new Function("stored", "storedRisk", "after", "evaluateAndStoreRisk", "setTimeout", "aid", "cycleId", "riskScoreVersion", route.slice(start, end));

test("PvE stored risk executes current, stale, missing, and wrong-version states", () => {
  const now = Date.now();
  const profileUpdatedAt = now - 60_000;
  const current = {
    score: 42,
    tier: "medium",
    confidence: 1,
    sampleN: 30,
    factors: [],
    freshnessAt: now,
    scoreVersion: riskScoreVersion("pve", "persistent"),
    profileUpdatedAt,
    evaluatedAt: now,
  };
  const staleProfile = { ...current, profileUpdatedAt: profileUpdatedAt - 1 };
  const staleEvaluation = { ...current, evaluatedAt: now - 6 * 60 * 60 * 1000 };
  const cases = [
    { name: "current", risk: current, refresh: false, publicRisk: current },
    { name: "stale profile", risk: staleProfile, refresh: true, publicRisk: staleProfile },
    { name: "stale evaluation", risk: staleEvaluation, refresh: true, publicRisk: staleEvaluation },
    { name: "missing", risk: null, refresh: true, publicRisk: null },
    { name: "wrong version", risk: { ...current, scoreVersion: 1 }, refresh: true, publicRisk: null },
  ];
  for (const fixture of cases) {
    const result = storedRiskRefreshPolicy(fixture.risk, "pve", profileUpdatedAt, now);
    assert.equal(result.refresh, fixture.refresh, fixture.name);
    assert.deepEqual(result.publicRisk, fixture.publicRisk, fixture.name);
  }
});

test("stored PvP profiles schedule only missing or stale risk after the response", async () => {
  const updatedAt = Date.now() - 60_000;
  const fresh = { profileUpdatedAt: updatedAt, evaluatedAt: Date.now(), scoreVersion: 2 };
  for (const [risk, known, expected] of [
    [null, true, 1],
    [{ ...fresh, profileUpdatedAt: updatedAt - 1 }, true, 1],
    [{ ...fresh, evaluatedAt: Date.now() - 6 * 60 * 60 * 1000 }, true, 1],
    [{ ...fresh, scoreVersion: 1 }, true, 1],
    [fresh, true, 0],
    [null, false, 0],
  ]) {
    const stored = { stats: { pvpStatsKnown: known, profileUpdatedAt: updatedAt }, achievementIds: ["achievement"] };
    const callbacks = [];
    const evaluations = [];
    schedule(stored, risk, (fn) => callbacks.push(fn), async (input) => evaluations.push(input), (fn) => fn(), 3003626, "persistent", () => 2);
    assert.equal(callbacks.length, expected);
    assert.equal(evaluations.length, 0);
    for (const callback of callbacks) await callback();
    assert.deepEqual(evaluations, expected ? [{ aid: 3003626, mode: "regular", cycleId: "persistent", ...stored }] : []);
  }
});
