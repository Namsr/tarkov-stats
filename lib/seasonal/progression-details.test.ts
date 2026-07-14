import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error Node's native TypeScript runner requires an explicit .ts extension.
import { buildSeasonalProgressionDetails } from "./progression-details.ts";
import type { ProgressionDetailIntervalRow } from "./progression-details.ts";
import type { SeasonalCounters } from "../../types/seasonal.ts";

function counters(overrides: Partial<SeasonalCounters> = {}): SeasonalCounters {
  return {
    experience: 0,
    pmcRaids: 0,
    scavRaids: 0,
    pmcSurvived: 0,
    pmcDeaths: 0,
    pmcKills: 0,
    killedPmc: 0,
    ...overrides,
  };
}

let sequence = 0;
function row(
  aid: number,
  localDate: string,
  changes: Partial<SeasonalCounters>,
  overrides: Partial<ProgressionDetailIntervalRow> = {},
): ProgressionDetailIntervalRow {
  sequence += 1;
  return {
    mode: "seasonal",
    cycleId: "s1",
    aid,
    localDate,
    endedAt: Date.parse(`${localDate}T12:00:00+03:00`) + sequence,
    elapsedDays: 1,
    status: "valid",
    changes: counters(changes),
    ...overrides,
  };
}

test("computes exact long-term deltas from valid covered intervals", () => {
  const result = buildSeasonalProgressionDetails({
    cycleId: "s1",
    aid: 1,
    trustedStaticScore: 25,
    intervals: [
      row(1, "2026-07-01", {
        experience: 1_000, pmcRaids: 4, pmcSurvived: 3, pmcDeaths: 1, pmcKills: 10, killedPmc: 4,
      }),
      row(1, "2026-07-03", {
        experience: 3_000, pmcRaids: 6, pmcSurvived: 2, pmcDeaths: 2, pmcKills: 14, killedPmc: 5,
      }, { elapsedDays: 2 }),
      row(1, "2026-07-04", { experience: -1 }, { status: "schema_anomaly" }),
    ],
  });

  assert.deepEqual(result.longTerm, {
    xpPerDay: 4_000 / 3,
    raidsPerDay: 10 / 3,
    pmcKillsPerDay: 3,
    pmcKillsPerRaid: 0.9,
    nonPmcKillsPerDay: 5,
    nonPmcKillsPerRaid: 1.5,
    survivalRate: 50,
    pvpKd: 3,
    aiKd: 5,
    overallPmcKd: 8,
    intervals: 2,
    coveredRaids: 10,
  });
});

test("builds anomaly populations only from valid same-cycle same-date Seasonal rows", () => {
  const target = row(1, "2026-07-02", {
    experience: 1_000_000, pmcRaids: 100, pmcSurvived: 100, pmcDeaths: 0, pmcKills: 200, killedPmc: 100,
  });
  const population = Array.from({ length: 19 }, (_, index) => row(index + 2, "2026-07-02", {
    experience: index * 10, pmcRaids: index + 1, pmcSurvived: 0, pmcDeaths: 1, pmcKills: index, killedPmc: 0,
  }));
  const excluded = [
    row(100, "2026-07-01", { experience: 1_000_000, pmcRaids: 1_000 }),
    row(101, "2026-07-02", { experience: 1_000_000, pmcRaids: 1_000 }, { cycleId: "s2" }),
    row(102, "2026-07-02", { experience: 1_000_000, pmcRaids: 1_000 }, { status: "reset" }),
  ];
  const result = buildSeasonalProgressionDetails({
    cycleId: "s1", aid: 1, trustedStaticScore: 0, intervals: [target, ...population, ...excluded],
  });

  assert.equal(result.risk.markers.length, 1);
  assert.equal(result.risk.markers[0].date, "2026-07-02");
  assert.ok(result.risk.markers[0].reasons.includes("pmc_raids_per_day"));
  assert.ok(result.risk.markers[0].reasons.includes("survival_rate"));
  assert.equal(result.risk.markers[0].score, 100);
});

test("excludes no-PMC-raid rows from per-raid percentiles", () => {
  const target = row(1, "2026-07-05", {
    experience: 100, pmcRaids: 1, pmcSurvived: 1, pmcKills: 1, killedPmc: 1,
  });
  const noRaidNoise = Array.from({ length: 20 }, (_, aid) => row(aid + 2, "2026-07-05", {
    experience: 1_000_000, pmcRaids: 0, pmcSurvived: 0, pmcKills: 1_000, killedPmc: 1_000,
  }));
  const result = buildSeasonalProgressionDetails({
    cycleId: "s1", aid: 1, trustedStaticScore: 0, intervals: [target, ...noRaidNoise],
  });

  assert.equal(result.risk.markers.length, 1);
  assert.deepEqual(result.risk.markers[0].reasons, ["pmc_raids_per_day"]);
  assert.equal(result.risk.markers[0].score, 10);
});

test("uses only the latest 14 anomalies and the exact 70/30 progression formula", () => {
  const dates = Array.from({ length: 15 }, (_, index) => `2026-07-${String(index + 1).padStart(2, "0")}`);
  const player = dates.map((date, index) => row(1, date, {
    experience: index === 0 ? 1_000_000 : 0,
    pmcRaids: index === 0 ? 1_000 : 0,
  }));
  const comparison = dates.flatMap((date) => Array.from({ length: 19 }, (_, index) => row(index + 2, date, {
    experience: index,
    pmcRaids: index,
  })));
  const result = buildSeasonalProgressionDetails({
    cycleId: "s1", aid: 1, trustedStaticScore: 50, intervals: [...player, ...comparison],
  });

  assert.equal(result.risk.progression, 0);
  assert.equal(result.risk.combined, 50);
  assert.equal(result.risk.markers.length, 1);
});

test("applies confidence and combines trusted static and progression risk through analytics", () => {
  const dates = ["2026-07-01", "2026-07-02", "2026-07-03"];
  const player = dates.map((date) => row(1, date, {
    experience: 100_000, pmcRaids: 10, pmcSurvived: 10, pmcDeaths: 0, pmcKills: 100, killedPmc: 50,
  }));
  const comparison = dates.flatMap((date) => Array.from({ length: 19 }, (_, index) => row(index + 2, date, {
    experience: index, pmcRaids: 1, pmcSurvived: 0, pmcDeaths: 1, pmcKills: 0, killedPmc: 0,
  })));
  const result = buildSeasonalProgressionDetails({
    cycleId: "s1", aid: 1, trustedStaticScore: 50, intervals: [...player, ...comparison],
  });

  assert.equal(result.risk.progression, 100);
  assert.deepEqual(result.risk.confidence, { value: 1, tier: "high" });
  assert.equal(result.risk.staticContribution, 20);
  assert.equal(result.risk.progressionContribution, 60);
  assert.equal(result.risk.combined, 80);
  assert.deepEqual(new Set(result.risk.reasons), new Set([
    "pmc_kills_per_raid", "pvp_kd", "survival_rate", "xp_per_pmc_raid",
    "all_kills_per_pmc_raid", "pmc_raids_per_day",
  ]));
});
