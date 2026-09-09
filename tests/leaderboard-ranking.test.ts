import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's direct TypeScript runner needs the explicit extension.
const { arpOrderKey, compareOrderKeys, kdValue, performanceScore } = await import("../lib/leaderboard/ranking.ts");

const formula = {
  killsWeight: 0.4,
  kdWeight: 0.3,
  killsPerMatchWeight: 0.3,
  smoothing: 20,
  referenceTotalKills: 500,
  referenceKillsPerMatch: 1,
  referenceDeathsPerMatch: 0.5,
};

test("performance score is finite for zero deaths and rejects an unusable reference", () => {
  assert.ok(Number.isFinite(performanceScore({ matches: 20, kills: 30, deaths: 0 }, formula)));
  assert.equal(performanceScore({ matches: 20, kills: 30, deaths: 1 }, { ...formula, referenceDeathsPerMatch: 0 }), null);
  assert.equal(performanceScore({ matches: 20, kills: 30, deaths: 1 }, { ...formula, kdWeight: 0.8 }), null);
  assert.equal(performanceScore({ matches: 20, kills: 30, deaths: 1 }, { ...formula, referenceTotalKills: 0 }), null);
  assert.equal(performanceScore({ matches: 20, kills: 30, deaths: 1 }, { ...formula, referenceTotalKills: -5 }), null);
  const few = performanceScore({ matches: 20, kills: 10, deaths: 10 }, formula);
  const many = performanceScore({ matches: 20, kills: 100, deaths: 10 }, formula);
  assert.ok(few != null && many != null && many > few);
});

test("v1 formula objects are rejected and zero inputs never produce NaN", () => {
  const v1 = { kdWeight: 0.7, killsPerMatchWeight: 0.3, smoothing: 20,
    referenceKillsPerMatch: 1, referenceDeathsPerMatch: 0.5 };
  assert.equal(performanceScore({ matches: 20, kills: 30, deaths: 10 }, v1 as unknown as typeof formula), null);
  for (const input of [{ matches: 20, kills: 0, deaths: 10 }, { matches: 0, kills: 0, deaths: 0 },
      { matches: 20, kills: 30, deaths: 0 }, { matches: 6, kills: 1, deaths: 1 }]) {
    const score = performanceScore(input, formula);
    assert.ok(score == null || Number.isFinite(score));
    assert.ok(score == null || score >= 0);
  }
});

test("ARP order resolves every required tie and finishes with ascending aid", () => {
  const base = { arp: 1800, blastGangMatches: 20, kills: 40, deaths: 20, killsPerMatch: 2 };
  const rows = [
    arpOrderKey({ ...base, aid: 9 }),
    arpOrderKey({ ...base, aid: 3 }),
    arpOrderKey({ ...base, aid: 7, blastGangMatches: 21 }),
    arpOrderKey({ ...base, aid: 5, deaths: 0 }),
  ].sort(compareOrderKeys);
  assert.deepEqual(rows.map((key) => -key[5]), [7, 5, 3, 9]);
});

test("zero-death K/D uses a class and never Infinity", () => {
  assert.deepEqual(kdValue(4, 0), { value: null, deathless: true, orderClass: 2 });
  assert.deepEqual(kdValue(0, 0), { value: null, deathless: true, orderClass: 0 });
  assert.equal(kdValue(4, 2).value, 2);
});
