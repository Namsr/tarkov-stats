/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Same direct Node runner and source hooks as Arena route tests.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  return specifier.startsWith("@/")
    ? { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href }
    : next(specifier, context);
} });
const { rateArenaMode, rateArena } = await import("../lib/arena/ts-rating.ts");
const { arenaTsReference } = await import("../lib/arena/ts-rating-reference.ts");
const { ARENA_MODE_KEYS } = await import("../types/arena.ts");
const reference = { metrics: Object.fromEntries(Object.entries({ kd_ratio: 2, kills_per_match: 10, damage_per_match: 1000, win_rate: 50 }).map(([metric, value]) => [metric, { value, count: 200 }])) };
const counters = { matches: 100, kills: 1000, deaths: 500, damage: 100000, wins: 50, losses: 50 };
const references = { version: "test", modes: Object.fromEntries(ARENA_MODE_KEYS.map((mode) => [mode, reference])) };
const makeProfile = (modeCounters) => ({ overall: { counters: { matches: Object.values(modeCounters).reduce((n, c) => n + c.matches, 0) } }, modes: Object.fromEntries(ARENA_MODE_KEYS.map((mode) => [mode, { counters: modeCounters[mode] ?? { matches: 0, kills: 0, deaths: 0, wins: 0, losses: 0, damage: 0 } }])) });

test("TSR baseline is 1, bounded, and independent of hours, HS and ARP", () => {
  assert.equal(rateArenaMode(counters, reference).rating, 1);
  assert.equal(rateArenaMode({ ...counters, hours: 99999, headshots: 9999, bestArp: 9999 }, reference).rating, 1);
  for (const changed of [
    { kills: 0, deaths: 999999, wins: 0, damage: 0 },
    { kills: 999999, deaths: 0, damage: 99999999, wins: 100, losses: 0 },
    { kills: 0, deaths: 0, damage: 0, wins: 0 },
  ]) {
    const result = rateArenaMode({ ...counters, ...changed }, reference);
    assert.ok(Number.isFinite(result.rating));
    assert.ok(result.rating >= 0 && result.rating <= 2);
  }
});

test("TSR rewards combat results, penalizes deaths, and shrinks small samples", () => {
  for (const changed of [{ kills: 1500 }, { damage: 200000 }, { wins: 70, losses: 30 }]) assert.ok(rateArenaMode({ ...counters, ...changed }, reference).rating > 1);
  assert.ok(rateArenaMode({ ...counters, deaths: 1000 }, reference).rating < 1);
  const small = { matches: 10, kills: 200, deaths: 50, damage: 20000, wins: 8, losses: 2 };
  const large = Object.fromEntries(Object.entries(small).map(([key, value]) => [key, value * 10]));
  assert.ok(rateArenaMode(small, reference).rating < rateArenaMode(large, reference).rating);
  assert.equal(rateArenaMode(small, reference).provisional, true);
  assert.equal(rateArenaMode(large, reference).provisional, false);
  assert.equal(rateArenaMode({ ...small, matches: 9, wins: 7 }, reference).displayReady, true);
  assert.equal(rateArenaMode({ ...small, matches: 1, wins: 1, losses: 0 }, reference).displayReady, true);
  assert.equal(rateArenaMode({ ...small, matches: 0, wins: 0, losses: 0 }, reference).displayReady, false);
});

test("TSR does not turn missing or contradictory counters into zeroes", () => {
  for (const changed of [{ kills: null }, { deaths: NaN }, { damage: Infinity }, { matches: -1 }, { wins: 101 }, { losses: 51 }, { wins: 1.5 }]) {
    assert.equal(rateArenaMode({ ...counters, ...changed }, reference).rating, null);
  }
  assert.equal(rateArenaMode({ ...counters, matches: 0 }, reference).rating, null);
  const insufficient = structuredClone(reference);
  insufficient.metrics.kd_ratio.count = 199;
  assert.equal(rateArenaMode(counters, insufficient).reason, "insufficient_reference");
  insufficient.metrics.kd_ratio.count = 200;
  insufficient.metrics.win_rate.value = 0;
  assert.equal(rateArenaMode(counters, insufficient).rating, null);
});

test("overall TSR normalizes modes before weighting and does not penalize unplayed modes", () => {
  const single = rateArena(makeProfile({ blastGang: counters }), references);
  assert.equal(single.overall.rating, single.modes.blastGang.rating);
  assert.equal(single.overall.complete, true);
  const other = { ...counters, matches: 200, kills: 4000, deaths: 1000, wins: 150, losses: 50, damage: 400000 };
  const mixed = rateArena(makeProfile({ blastGang: counters, lastHero: other }), references);
  assert.equal(mixed.overall.rating, (100 * mixed.modes.blastGang.rating + 200 * mixed.modes.lastHero.rating) / 300);
  assert.equal(mixed.overall.ratedMatches, 300);
});

test("overall TSR refuses incomplete coverage, unknown counts and inconsistent totals", () => {
  const profile = makeProfile({ blastGang: counters, lastHero: { ...counters, damage: null } });
  assert.equal(rateArena(profile, references).overall.rating, null);
  profile.modes.lastHero.counters = { ...counters, matches: null };
  assert.equal(rateArena(profile, references).overall.complete, false);
  const wrongTotal = makeProfile({ blastGang: counters });
  wrongTotal.overall.counters.matches = 200;
  assert.equal(rateArena(wrongTotal, references).overall.reason, "incomplete_coverage");
  const empty = rateArena(makeProfile({}), references);
  assert.equal(empty.overall.rating, null);
  assert.equal(empty.overall.reason, "no_matches");
});

test("overall TSR rejects contradictory zero-match modes instead of silently omitting them", () => {
  // Every additive counter, not just the rated ones: a mode that reports assists
  // or MVP awards but zero matches is equally contradictory.
  for (const key of ["kills", "deaths", "assists", "headshots", "damage", "wins", "losses", "round_mvp", "match_mvp"]) {
    // Only the counter under test is non-zero, so each key is checked in isolation.
    const mode = rateArenaMode({ matches: 0, kills: 0, deaths: 0, wins: 0, losses: 0, damage: 0, [key]: 1 }, reference);
    assert.equal(mode.reason, "inconsistent_results", key);
    assert.equal(mode.rating, null, key);
    const profile = makeProfile({ blastGang: counters });
    Object.assign(profile.modes.lastHero.counters, { [key]: 1 });
    const result = rateArena(profile, references);
    assert.equal(result.modes.lastHero.reason, "inconsistent_results", key);
    assert.equal(result.modes.lastHero.rating, null, key);
    assert.equal(result.overall.rating, null, key);
    assert.equal(result.overall.complete, false, key);
    assert.equal(result.overall.reason, "incomplete_coverage", key);
  }
  // A genuinely unplayed mode stays benign and keeps the overall rating complete.
  const unplayed = rateArena(makeProfile({ blastGang: counters }), references);
  assert.equal(unplayed.modes.lastHero.reason, "no_matches");
  assert.equal(unplayed.overall.complete, true);
  assert.equal(unplayed.overall.rating, unplayed.modes.blastGang.rating);
});

test("fixed reference reproduces the approved Arena prototype", () => {
  const c = (matches, kills, deaths, wins, losses, damage) => ({ matches, kills, deaths, wins, losses, damage });
  const result = rateArena(makeProfile({
    teamFight: c(10, 87, 36, 7, 3, 14105), lastHero: c(63, 2932, 1766, 49, 14, 635490),
    checkpoint: c(70, 2176, 1302, 46, 24, 510472), blastGang: c(97, 1252, 555, 75, 22, 189851),
    shootOutDuo: c(11, 91, 59, 2, 9, 31170),
  }), arenaTsReference);
  assert.equal(result.overall.rating.toFixed(2), "1.18");
  assert.deepEqual(ARENA_MODE_KEYS.map((mode) => result.modes[mode].rating.toFixed(2)), ["1.08", "1.23", "1.11", "1.22", "0.98"]);
  assert.equal(result.overall.complete, true);
});
