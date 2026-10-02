import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error Node's strip-types runner needs explicit extensions.
import { comparisonDossier, comparisonAdvantage, comparisonTimelineBenchmark } from "../lib/comparison-dossier.ts";
import type { ProgressionTimelineResponse } from "../types/seasonal";
const scope = { mode: "seasonal", cycleId: "s1", arenaMode: null } as const;
const identity = { aid: 1, mode: "seasonal", cycleId: "s1" };
function payload() {
  return { identity, profile: { aid: 1, nickname: "Player", seasonalStats: { runThrough: 0, pmcSurvivalRate: 40 }, counters: { pmcRaids: 10, killedPmc: 5 } },
    viewModel: { identity, statistics: {}, overview: {}, achievements: { items: [] }, skills: { items: [] }, mastering: { items: [] } } };
}
test("dossier preserves recorded zero, leaves absent counters unavailable and keeps PMC targets distinct", () => {
  const dossier = comparisonDossier(scope, 1, payload())!;
  assert.equal(dossier.values.runThrough, 0);
  assert.equal(dossier.values.pmcDeaths, null);
  assert.equal(dossier.values.killedPmc, 5);
  assert.equal(dossier.values.pmcAllKills, null);
  assert.equal(dossier.values.killedPmcPerRaid, .5);
});

test("public Seasonal DTO retains combat summaries and exact recorded survival outcomes", () => {
  const body = payload();
  const dossier = comparisonDossier(scope, 1, { ...body,
    profile: { ...body.profile, seasonalStats: undefined },
    comparisonStats: { longestWinStreak: 10, killsPerRaid: 2.5 },
    viewModel: { ...body.viewModel, statistics: { survivedRaids: 7, runThrough: 0 } },
  })!;
  assert.equal(dossier.values.longestWinStreak, 10);
  assert.equal(dossier.values.killsPerRaid, 2.5);
  assert.equal(dossier.values.survivedRaids, 7);
  assert.equal(dossier.values.runThrough, 0);
});
test("profile and view-model identities cannot cross account, mode or season", () => {
  for (const changed of [{ aid: 2 }, { mode: "pve" }, { cycleId: "s2" }]) {
    const body = payload();
    assert.equal(comparisonDossier(scope, 1, { ...body, identity: { ...identity, ...changed } }), null);
    assert.equal(comparisonDossier(scope, 1, { ...body, viewModel: { ...body.viewModel, identity: { ...identity, ...changed } } }), null);
  }
});
test("a missing exact PMC-kill counter masks PvP K/D but preserves known survival and zeros", () => {
  const regular = { mode: "regular", cycleId: "persistent", arenaMode: null } as const;
  const dossier = comparisonDossier(regular, 1, { identity: { aid: 1, ...regular }, stats: { nickname: "A", pvpStatsKnown: false, pmcKdRatio: 0, pmcSurvivalRate: 75, runThrough: 0 } })!;
  assert.equal(dossier.values.pmcKdRatio, null);
  assert.equal(dossier.values.killedPmc, null);
  assert.equal(dossier.values.pmcSurvivalRate, 75);
  assert.equal(dossier.values.runThrough, 0);
});
test("multipliers use actual values and never divide by zero or rank missing values", () => {
  assert.deepEqual(comparisonAdvantage(2, 5), { winner: 1, ratio: 2.5, difference: 3 });
  assert.deepEqual(comparisonAdvantage(5, 2), { winner: 0, ratio: 2.5, difference: 3 });
  assert.deepEqual(comparisonAdvantage(0, 5), { winner: 1, ratio: null, difference: 5 });
  for (const pair of [[null, 5], [5, null], [5, 5], [Infinity, 5], [-1, 5]] as const) assert.equal(comparisonAdvantage(pair[0], pair[1]), null);
});
test("collections retain all valid entries and reject internal skills, unsafe images and malformed mastery", () => {
  const body = payload();
  const dossier = comparisonDossier(scope, 1, { ...body, viewModel: { ...body.viewModel,
    achievements: { items: [{ id: "x", name: "A", imageUrl: "javascript:alert(1)" }, { id: "y", imageUrl: "https://assets.tarkov.dev/achievement-6512eb3ddfb0ae1ee75a0376-icon.webp" }] },
    skills: { items: [{ id: "BotSound", progress: 100 }, { id: "Endurance", progress: 5100 }, { id: "Strength", progress: 0 }] },
    mastering: { items: [{ id: "AKM", weapon: "AKM", progress: 0, level: 1 }, { id: "x", weapon: "x", progress: -1, level: 1 }] },
  } })!;
  assert.equal(dossier.achievements.length, 2);
  assert.equal(dossier.achievements[0].imageUrl, null);
  assert.ok(dossier.achievements[1].imageUrl);
  assert.deepEqual(dossier.skills.map(item => item.id), ["Endurance"]);
  assert.equal(dossier.skills[0].elite, true);
  assert.equal(dossier.mastery.length, 1);
  assert.equal(dossier.mastery[0].progress, 0);
});
test("Arena uses its own overall and mode counters and retains missing values", () => {
  const arena = { mode: "arena", cycleId: "persistent", arenaMode: "overall" } as const;
  const dossier = comparisonDossier(arena, 1, { identity: { aid: 1, ...arena }, arena: { nickname: "Arena", overall: { hours: 0, bestArp: 100, counters: { matches: 0, deaths: null }, metrics: { kd_ratio: null } }, modes: { lastHero: { counters: { wins: 5 }, metrics: { win_rate: 50 } } } } })!;
  assert.equal(dossier.values.hours, 0);
  assert.equal(dossier.values.arena_overall_matches, 0);
  assert.equal(dossier.values.arena_overall_deaths, null);
  assert.equal(dossier.values.arena_lastHero_wins, 5);
  assert.equal(dossier.values.arena_lastHero_win_rate, 50);
  assert.equal(dossier.values.pmcRaids, null);
});

test("Arena gauges preserve native overall risk, rating readiness and zero results", () => {
  const arena = { mode: "arena", cycleId: "persistent", arenaMode: "overall" } as const;
  const body = { identity: { aid: 1, ...arena }, arena: { overall: { counters: { matches: 0, wins: 0, losses: 0 }, metrics: { win_rate: 0 } } },
    risk: { score: 99, overall: { score: 0 } },
    tsRating: { overall: { rating: 1.5, displayReady: false, reason: "incomplete_coverage", provisional: true } } };
  const dossier = comparisonDossier(arena, 1, body)!;
  assert.equal(dossier.values.arenaRisk, 0);
  assert.equal(dossier.values.arena_overall_win_rate, 0);
  assert.equal(dossier.arenaRating?.rating, null);
  assert.equal(dossier.arenaRating?.reason, "incomplete_coverage");
  assert.equal(dossier.arenaRating?.displayReady, false);
  body.tsRating.overall.displayReady = true;
  assert.equal(comparisonDossier(arena, 1, body)?.arenaRating?.rating, 1.5);
  assert.equal(comparisonDossier(arena, 1, { ...body, tsRating: undefined, risk: { score: 99 } })?.values.arenaRisk, null);
  assert.equal(comparisonDossier(arena, 1, { ...body, tsRating: undefined })?.arenaRating, null);
});
test("timeline benchmark prefers matched data at the nearest raid count and falls back without inventing values", () => {
  const point = (pmcRaids: number, value: number | null, n = 20) => ({ pmcRaids, value, n, observedAt: 100 });
  const timeline = { metrics: { pvp_kd: { player: [point(100, 2)], nearby: [point(10, 8), point(95, 3)], overall: [point(100, 4)] } } } as unknown as ProgressionTimelineResponse;
  assert.deepEqual(comparisonTimelineBenchmark(timeline, "pvp_kd"), { value: 3, n: 20, population: false });
  timeline.metrics.pvp_kd!.nearby = [];
  assert.deepEqual(comparisonTimelineBenchmark(timeline, "pvp_kd"), { value: 4, n: 20, population: true });
  timeline.metrics.pvp_kd!.overall[0].n = 0;
  assert.equal(comparisonTimelineBenchmark(timeline, "pvp_kd"), null);
  assert.equal(comparisonTimelineBenchmark(timeline, "survival"), null);
});
