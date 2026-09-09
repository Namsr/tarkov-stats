import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's direct TypeScript runner needs the explicit extension.
import { LEADERBOARD_FORMULA_VERSION, LEADERBOARD_METRIC_VERSION, materializeCandidate, referenceFormula } from "../lib/leaderboard/materialize.ts";
// @ts-expect-error Node's direct TypeScript runner needs the explicit extension.
import { leaderboardFullReason } from "../lib/leaderboard/config.ts";

const baseConfig = {
  scope: "regular", mode: "regular" as const, arenaMode: null, cycleId: null, primaryMetric: "performance" as const,
  minimumSample: 6, activityCutoffMs: 100, arpSeasonId: null, arpSourceConfirmed: false,
};
const formula = { killsWeight: .4, kdWeight: .3, killsPerMatchWeight: .3, smoothing: 20,
  referenceTotalKills: 500, referenceKillsPerMatch: 1, referenceDeathsPerMatch: .5 };
const row = { aid: 1, nickname: "One", sourceUpdatedAt: 1, parserVersion: 0,
  activityAt: 101, activitySource: "skill" as const, matches: 20, kills: 20, deaths: 10,
  hours: 10, currentArp: null, bestArp: null };

test("score orders use the composite and reject missing hours or insufficient mode samples", () => {
  const candidate = materializeCandidate(row, { config: baseConfig, formula });
  assert.ok(candidate.member.score! > 0);
  assert.equal(candidate.member.stats.performanceScore, candidate.member.score);
  assert.equal(candidate.orders.find((order) => order.sort === "score")?.key[0], candidate.member.score);
  for (const change of [{ hours: null }, { hours: -1 }, { matches: 5 }, { deaths: null }]) {
    const result = materializeCandidate({ ...row, ...change }, { config: baseConfig, formula });
    assert.equal(result.orders.some((order) => order.sort === "score"), false);
  }
});

test("raw K/D sorting follows displayed values, including zero deaths", () => {
  const smaller = materializeCandidate({ ...row, kills: 353, deaths: 0, aid: 1 }, { config: baseConfig, formula });
  const larger = materializeCandidate({ ...row, kills: 370, deaths: 0, aid: 2 }, { config: baseConfig, formula });
  assert.equal(smaller.orders.find((order) => order.sort === "kd")!.key[0], 353);
  assert.equal(larger.orders.find((order) => order.sort === "kd")!.key[0], 370);
  const finite = materializeCandidate({ ...row, kills: 400, deaths: 1, hours: null }, { config: baseConfig, formula });
  assert.equal(finite.orders.find((order) => order.sort === "kd")!.key[0], 400);
});

test("focused requests retain the published order until an old metric generation is rebuilt", async () => {
  // @ts-expect-error Node's direct TypeScript runner needs the explicit extension.
  const { prepareLeaderboardCandidate } = await import("../lib/leaderboard/runtime.ts");
  const reader = { snapshot: () => ({ generation: 123, generatedAt: 456, params: { metricVersion: 2 } }) };
  assert.deepEqual(await prepareLeaderboardCandidate(reader as unknown as Parameters<typeof prepareLeaderboardCandidate>[0], baseConfig, 1),
    { generation: 123, generatedAt: 456, candidate: null });
});

test("the public parser accepts score sorting in BlastGang and the other modes", async () => {
  // @ts-expect-error Node's direct TypeScript runner needs the explicit extension.
  const { parseLeaderboardRequest } = await import("../lib/leaderboard/runtime.ts");
  for (const mode of ["regular", "pve", "arena"]) {
    const request = parseLeaderboardRequest(new URLSearchParams({ mode, sort: "score" }));
    assert.equal(request.sort, "score");
  }
});

test("inactive profiles are absent from every order and the reference sample", () => {
  const inactive = { ...row, activityAt: 99, kills: 10_000 };
  assert.equal(materializeCandidate(inactive, { config: baseConfig, formula }).member.status, "inactive");
  assert.deepEqual(materializeCandidate(inactive, { config: baseConfig, formula }).orders, []);
  assert.equal(referenceFormula([inactive], 100), null);
});

test("ARP ranks without tie metrics and LastHero does not require deaths", () => {
  const arpConfig = { ...baseConfig, scope: "arena:blastGang:initial", mode: "arena" as const,
    arenaMode: "blastGang" as const, cycleId: null, primaryMetric: "arp" as const, arpSeasonId: "initial", arpSourceConfirmed: true };
  const arp = materializeCandidate({ ...row, matches: null, kills: null, deaths: null, bestArp: 1800 },
    { config: arpConfig, formula: null });
  assert.equal(arp.member.status, "ranked");
  assert.equal(arp.orders.some((order) => order.sort === "primary"), true);

  const lastHero = { ...arpConfig, scope: "arena:lastHero", arenaMode: "lastHero" as const,
    primaryMetric: "killsPerMatch" as const, arpSeasonId: null };
  assert.equal(materializeCandidate({ ...row, deaths: null }, { config: lastHero, formula: null }).member.status, "ranked");
});

test("ordinary changes stay incremental while incompatible publication inputs force full", () => {
  const current = { formulaVersion: LEADERBOARD_FORMULA_VERSION, params: { ...baseConfig, formula, metricVersion: LEADERBOARD_METRIC_VERSION,
    exclusionFingerprint: "ban-a" } };
  const input = { current, config: baseConfig, formulaVersion: LEADERBOARD_FORMULA_VERSION, metricVersion: LEADERBOARD_METRIC_VERSION,
    exclusionFingerprint: "ban-a", forceFull: false, journalCreated: false };
  assert.equal(leaderboardFullReason(input), null);
  assert.equal(leaderboardFullReason({ ...input, current: null }), "initial");
  assert.equal(leaderboardFullReason({ ...input, journalCreated: true }), "journal_initialized");
  assert.equal(leaderboardFullReason({ ...input, metricVersion: LEADERBOARD_METRIC_VERSION + 1 }), "metric_version");
  assert.equal(leaderboardFullReason({ ...input,
    current: { ...current, params: { ...current.params, metricVersion: 1 } } }), "metric_version");
  assert.equal(materializeCandidate(row, { config: baseConfig, formula }).member.metricVersion, LEADERBOARD_METRIC_VERSION);
  assert.equal(leaderboardFullReason({ ...input, exclusionFingerprint: "ban-b" }), "exclusions");
  assert.equal(leaderboardFullReason({ ...input, config: { ...baseConfig, minimumSample: 7 } }), "config");
  assert.equal(leaderboardFullReason({ ...input,
    current: { ...current, formulaVersion: LEADERBOARD_FORMULA_VERSION - 1 } }), "formula_version");
});

test("a null-reference base becomes rankable once changed profiles form a valid cohort", () => {
  assert.equal(referenceFormula([], baseConfig.activityCutoffMs), null);
  const cohort = Array.from({ length: 20 }, (_, index) => ({ ...row, aid: index + 100,
    matches: 20, kills: 30, deaths: 10 }));
  const available = referenceFormula(cohort, baseConfig.activityCutoffMs);
  assert.ok(available);
  assert.equal(materializeCandidate(cohort[0], { config: baseConfig, formula: available }).member.status, "ranked");
  const sorts = materializeCandidate(row, { config: baseConfig, formula }).orders.map((order) => order.sort).sort();
  assert.deepEqual(sorts, ["hours", "kd", "kills", "killsPerMatch", "primary", "score"]);
});

test("reference cohorts reject degenerate medians without division by zero", () => {
  const single = [{ ...row, aid: 201, matches: 20, kills: 30, deaths: 10 }];
  const one = referenceFormula(single, baseConfig.activityCutoffMs);
  assert.ok(one && one.referenceTotalKills === 30);
  assert.equal(referenceFormula([{ ...row, aid: 202, matches: 20, kills: 0, deaths: 10 }], baseConfig.activityCutoffMs), null);
  assert.equal(referenceFormula([{ ...row, aid: 203, matches: 20, kills: 30, deaths: 0 }], baseConfig.activityCutoffMs), null);
  assert.equal(referenceFormula([{ ...row, aid: 204, activityAt: 99, matches: 20, kills: 10_000, deaths: 10 }],
    baseConfig.activityCutoffMs), null);
});
