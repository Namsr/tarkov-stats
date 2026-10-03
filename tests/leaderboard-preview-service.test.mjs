import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const state = { snapshot: null, stored: null, seasonal: null, arena: null, cohort: null, calls: [] };
globalThis.previewServiceTest = state;
const stubs = {
  "@/lib/db": `export async function getStore(mode) { return {
    stored: async () => globalThis.previewServiceTest.stored,
    cohort2d: async (...args) => { const s = globalThis.previewServiceTest; s.calls.push([mode, ...args]); return s.cohort; }
  }; }`,
  "@/lib/progression-db": `export async function getProgressionStore() { return { latest: async () => globalThis.previewServiceTest.snapshot }; }`,
  "@/lib/seasonal/storage": `export async function getSeasonalStore() { return { getProfile: async () => globalThis.previewServiceTest.seasonal }; }`,
  "@/lib/seasonal/comparison-cohort": `export async function querySeasonalComparisonCohort() { return { result: globalThis.previewServiceTest.cohort }; }`,
  "@/lib/arena/service": `export async function getArenaProfile() { return globalThis.previewServiceTest.arena; }
    export async function getArenaCohort() { return globalThis.previewServiceTest.cohort; }
    export async function getArenaAverage() { return { sampleN: 20, metrics: { kd_ratio: { value: 2, count: 20 } } }; }`,
  "@/lib/arena-average-cache": `export async function arenaAverageCacheVersion() { return 1; }`,
  "@/lib/average-dynamic-cache": `export async function loadDynamicAverage(key, loader) { return { value: await loader() }; }`,
};
registerHooks({ resolve(specifier, context, nextResolve) {
  if (stubs[specifier]) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}` };
  if (specifier === "@/lib/profile-cohort") return { shortCircuit: true, url: new URL("../lib/profile-cohort.ts", import.meta.url).href };
  return nextResolve(specifier, context);
} });
const { loadLeaderboardPreview } = await import("../lib/leaderboard/preview.ts");
const scope = { mode: "regular", cycleId: null, arenaMode: null };
const pmcKills = (card) => card.metrics.find((metric) => metric.label === "seasonal.metric.pmcKillsPerRaid");

test("persistent preview uses the latest snapshot and the shared two-dimensional cohort", async () => {
  state.stored = { stats: { nickname: "old", pmcKilledPmc: 100 } };
  state.snapshot = { stats: { nickname: "latest", hoursPlayed: 100, pmcRaids: 20, pvpStatsKnown: true, pvpStatsVersion: 1, pmcKilledPmc: 0 } };
  state.cohort = { quality: "sufficient", averages: { killed_pmc_per_raid: { value: 0.5, count: 20 } } };
  const card = await loadLeaderboardPreview(42, scope);
  assert.equal(card.nickname, "latest");
  assert.equal(pmcKills(card).value, 0);
  assert.equal(pmcKills(card).average, 0.5);
  assert.deepEqual(state.calls.at(-1), ["regular", 100, 20, 42, "hours", "trimmed_mean", "all"]);
  state.snapshot.stats.pvpStatsVersion = 0;
  assert.equal(pmcKills(await loadLeaderboardPreview(42, scope)).value, null);
  state.snapshot = state.stored = null;
  assert.equal(await loadLeaderboardPreview(42, scope), null);
});

test("seasonal preview retains cycle identity and the exact PMC counter", async () => {
  state.seasonal = { nickname: "seasonal", lifetimePvpHours: 500, pvpStatsVersion: 1,
    counters: { pmcRaids: 10, pmcKills: 100, pmcKilledPmc: 5, pmcDeaths: 2, pmcSurvived: 8 },
    seasonalStats: { level: 24, prestige: 6, totalKills: 100 } };
  const card = await loadLeaderboardPreview(42, { mode: "pvp-season", cycleId: "cycle-test", arenaMode: null });
  assert.equal(card.cycleId, "cycle-test");
  assert.equal(card.prestige, 6);
  assert.equal(pmcKills(card).value, 0.5);
  assert.equal(card.totals.find((total) => total.label === "player.pmcKills").value, 5);
});

test("Arena preview uses its own counters and population fallback", async () => {
  state.arena = { nickname: "arena", overall: { hours: 100 }, modes: { lastHero: { counters: { matches: 25, kills: 75 }, metrics: { kd_ratio: 3 } } } };
  state.cohort = { reason: "insufficient_cohort", quality: "unavailable", metrics: {} };
  const card = await loadLeaderboardPreview(42, { mode: "arena", cycleId: null, arenaMode: "lastHero" });
  assert.equal(card.metrics[0].label, "arena.metric.kd_ratio");
  assert.equal(card.metrics[0].value, 3);
  assert.equal(card.metrics[0].average, 2);
  assert.equal(card.raids, 25);
  assert.equal(card.totals[0].value, 75);
});
