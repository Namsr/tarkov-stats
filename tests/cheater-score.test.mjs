import assert from "node:assert/strict";
import test from "node:test";

import { scoreCheater } from "../lib/cheater-score.ts";

const account14280186 = {
  nickname: "7LL",
  level: 0,
  prestige: 6,
  experience: 11_411_930,
  side: "Usec",
  totalRaids: 1_588,
  pmcRaids: 1_588,
  scavRaids: 0,
  survivedRaids: 1_196,
  survivalRate: 75.3,
  totalKills: 8_193,
  killedPmc: 985,
  killsPerRaid: 5.16,
  kdRatio: 26.62,
  pmcKdRatio: 26.62,
  deaths: 37,
  pmcDeaths: 37,
  runThrough: 0,
  pmcSurvived: 1_196,
  pmcSurvivalRate: 75.3,
  pmcKills: 8_193,
  pmcKillsPerRaid: 5.16,
  pmcExitKilled: 37,
  pmcExitLeft: 0,
  pmcExitTransit: 0,
  pmcExitMia: 0,
  hoursPlayed: 1_269.2,
  longestWinStreak: 77,
  achievementsCount: 68,
  registrationDate: 0,
  lastActiveDate: 0,
  avgLifespan: 0,
  totalLootValue: 0,
};

const productionBracket = {
  n: 201,
  metrics: {
    pmc_survival_rate: { n: 136, mean: 45.9139705882, std: 12.3372473619 },
    pmc_kd_ratio: { n: 183, mean: 1.0478688525, std: 1.9978191236 },
    pmc_kills_per_raid: { n: 136, mean: 2.9355882353, std: 1.1021875072 },
    longest_win_streak: { n: 194, mean: 12.7783505155, std: 8.7577562301 },
  },
};

const lateAchievement = {
  ownedIds: ["68d3ff840531ed76e808866c"],
  stats: [
    {
      id: "68d3ff840531ed76e808866c",
      owners: 19,
      samplePct: 0.1543460601,
      meanHours: 6_725.4,
      earlyHours: 847.1,
    },
  ],
};

test("extreme combat and progression profile saturates at 100", () => {
  const result = scoreCheater(account14280186, productionBracket, lateAchievement);

  assert.equal(result.score, 100);
  assert.equal(result.tier, "severe");
  assert.equal(result.factors.find((factor) => factor.key === "pmc_kd_ratio")?.points, 30);
  assert.equal(result.factors.find((factor) => factor.key === "prestige")?.points, 22);
  assert.ok((result.factors.find((factor) => factor.key === "ach_early")?.points ?? 0) > 16);
});

test("one extreme stat cannot create a severe score by itself", () => {
  const result = scoreCheater(
    {
      ...account14280186,
      prestige: 0,
      pmcKdRatio: 8,
      pmcSurvivalRate: 50,
      pmcKillsPerRaid: 2,
      longestWinStreak: 10,
      achievementsCount: 0,
    },
    null,
    null
  );

  assert.equal(result.score, 30);
  assert.equal(result.tier, "medium");
  assert.equal(result.factors.find((factor) => factor.key === "compound_anomaly")?.points, 0);
});

test("prestige six at veteran playtime is not suspicious by pace alone", () => {
  const result = scoreCheater(
    {
      ...account14280186,
      hoursPlayed: 4_000,
      pmcKdRatio: 1.2,
      pmcSurvivalRate: 50,
      pmcKillsPerRaid: 2,
      longestWinStreak: 10,
      achievementsCount: 0,
    },
    null,
    null
  );

  assert.equal(result.score, 0);
  assert.equal(result.factors.find((factor) => factor.key === "prestige")?.points, 0);
});
