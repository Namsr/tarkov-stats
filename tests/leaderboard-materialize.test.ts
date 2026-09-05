import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's direct TypeScript runner needs the explicit extension.
import { materializeCandidate, referenceFormula } from "../lib/leaderboard/materialize.ts";
// @ts-expect-error Node's direct TypeScript runner needs the explicit extension.
import { leaderboardFullReason } from "../lib/leaderboard/config.ts";

const baseConfig = {
  scope: "regular", mode: "regular" as const, arenaMode: null, cycleId: null, primaryMetric: "performance" as const,
  minimumSample: 6, activityCutoffMs: 100, arpSeasonId: null, arpSourceConfirmed: false,
};
const formula = { kdWeight: .7, killsPerMatchWeight: .3, smoothing: 20,
  referenceKillsPerMatch: 1, referenceDeathsPerMatch: .5 };
const row = { aid: 1, nickname: "One", sourceUpdatedAt: 1, parserVersion: 0,
  activityAt: 101, activitySource: "skill" as const, matches: 20, kills: 20, deaths: 10,
  hours: 10, currentArp: null, bestArp: null };

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
  const current = { formulaVersion: 1, params: { ...baseConfig, formula, metricVersion: 1,
    exclusionFingerprint: "ban-a" } };
  const input = { current, config: baseConfig, formulaVersion: 1, metricVersion: 1,
    exclusionFingerprint: "ban-a", forceFull: false, journalCreated: false };
  assert.equal(leaderboardFullReason(input), null);
  assert.equal(leaderboardFullReason({ ...input, current: null }), "initial");
  assert.equal(leaderboardFullReason({ ...input, journalCreated: true }), "journal_initialized");
  assert.equal(leaderboardFullReason({ ...input, metricVersion: 2 }), "metric_version");
  assert.equal(leaderboardFullReason({ ...input, exclusionFingerprint: "ban-b" }), "exclusions");
  assert.equal(leaderboardFullReason({ ...input, config: { ...baseConfig, minimumSample: 7 } }), "config");
});

test("a null-reference base becomes rankable once changed profiles form a valid cohort", () => {
  assert.equal(referenceFormula([], baseConfig.activityCutoffMs), null);
  const cohort = Array.from({ length: 20 }, (_, index) => ({ ...row, aid: index + 100,
    matches: 20, kills: 30, deaths: 10 }));
  const available = referenceFormula(cohort, baseConfig.activityCutoffMs);
  assert.ok(available);
  assert.equal(materializeCandidate(cohort[0], { config: baseConfig, formula: available }).member.status, "ranked");
});
