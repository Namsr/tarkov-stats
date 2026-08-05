import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  isSeasonalUpstreamReady,
  parseSeasonalProfile,
  seasonalLastAccess,
  validateSeasonalProfile,
} from "../lib/seasonal-upstream.ts";

const fixtures = new URL("./fixtures/", import.meta.url);
const loadFixture = async (name) =>
  JSON.parse(await readFile(new URL(name, fixtures), "utf8"));

const baseOptions = {
  enabled: true,
  cycleId: "season-2026-01",
  seasonStartsAt: 1_783_000_000_000,
  seasonEndsAt: 1_784_000_000_000,
};

test("adapts the confirmed separate gameMode contract", async () => {
  const payload = await loadFixture("seasonal-game-mode.json");
  const profile = parseSeasonalProfile(payload, {
    ...baseOptions,
    confirmedContract: "game_mode",
    lifetimePvpHours: 640.5,
  });

  assert.deepEqual(profile, {
    mode: "seasonal",
    cycleId: "season-2026-01",
    aid: 730001,
    nickname: "SolRunner",
    profileUpdatedAt: 1_783_501_200_000,
    lastAccessAt: 1_783_500_000_000,
    lifetimePvpHours: 640.5,
    counters: {
      experience: 125000,
      pmcRaids: 12,
      scavRaids: 3,
      pmcSurvived: 7,
      pmcDeaths: 5,
      pmcKills: 31,
      killedPmc: 8,
    },
    staticSignals: {
      prestige: 0,
      longestWinStreak: 0,
      achievementIds: ["first_raid"],
    },
  });
});

test("adapts the confirmed Seasonal section of a common profile", async () => {
  const payload = await loadFixture("seasonal-profile-section.json");
  const result = validateSeasonalProfile(payload, {
    ...baseOptions,
    confirmedContract: "profile_section",
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.profile.aid, 730002);
  assert.equal(result.ok && result.profile.lastAccessAt, 1_783_587_000_000);
  assert.equal(result.ok && result.profile.counters.pmcRaids, 4);
  assert.deepEqual(result.ok && result.profile.staticSignals?.achievementIds, ["newest", "older"]);
});

test("adapts an ordinary raw profile when direct_profile is explicitly confirmed", async () => {
  const payload = await loadFixture("seasonal-direct-profile.json");
  const profile = parseSeasonalProfile(payload, {
    ...baseOptions,
    confirmedContract: "direct_profile",
    seasonStartsAt: 1_785_800_000_000,
    seasonEndsAt: null,
  });

  assert.equal(profile.aid, 730003);
  assert.equal(profile.cycleId, baseOptions.cycleId);
  assert.equal(profile.profileUpdatedAt, 1_785_969_007_540);
  assert.equal(profile.lastAccessAt, 1_785_967_182_000);
  assert.equal(profile.counters.pmcRaids, 112);
  assert.equal(profile.counters.scavRaids, 8);
  assert.equal(profile.counters.pmcSurvived, 41);
  assert.equal(profile.counters.pmcDeaths, 65);
  assert.equal(profile.counters.pmcKills, 351);
  assert.equal(profile.counters.killedPmc, 79);
  assert.equal(profile.staticSignals?.longestWinStreak, 6);
});

test("LastAccess is the maximum across Common skills and achievement timestamps", () => {
  assert.equal(
    seasonalLastAccess({
      skills: { Common: [{ LastAccess: 1_783_570_000 }] },
      achievements: { a: 1_783_580_000, b: 1_783_560_000 },
    }),
    1_783_580_000_000
  );
});

test("stays fail-closed until both flag and contract confirmation are present", async () => {
  const payload = await loadFixture("seasonal-game-mode.json");

  assert.equal(isSeasonalUpstreamReady({ enabled: false, confirmedContract: "game_mode" }), false);
  assert.equal(isSeasonalUpstreamReady({ enabled: true, confirmedContract: null }), false);
  assert.equal(isSeasonalUpstreamReady({ enabled: true, confirmedContract: "game_mode" }), true);

  assert.equal(
    validateSeasonalProfile(payload, {
      ...baseOptions,
      enabled: false,
      confirmedContract: "game_mode",
    }).code,
    "feature_disabled"
  );
  assert.equal(
    validateSeasonalProfile(payload, { ...baseOptions, confirmedContract: null }).code,
    "contract_unconfirmed"
  );
  assert.equal(
    validateSeasonalProfile(payload, {
      ...baseOptions,
      confirmedContract: "profile_section",
    }).code,
    "contract_mismatch"
  );
});

test("rejects a mismatched cycle, out-of-season activity and zero raids", async () => {
  const payload = await loadFixture("seasonal-game-mode.json");
  const options = { ...baseOptions, confirmedContract: "game_mode" };

  assert.equal(
    validateSeasonalProfile(payload, { ...options, cycleId: "another-cycle" }).code,
    "cycle_mismatch"
  );

  const outsideSeason = structuredClone(payload);
  outsideSeason.profile.skills.Common[1].LastAccess = 1_782_000_000;
  outsideSeason.profile.achievements.first_raid = 1_782_000_000;
  outsideSeason.profile.skills.Common[0].LastAccess = 1_782_000_000;
  assert.equal(validateSeasonalProfile(outsideSeason, options).code, "outside_season");

  const zeroRaids = structuredClone(payload);
  zeroRaids.profile.pmcStats.eft.overAllCounters.Items.find(
    (item) => item.Key[0] === "Sessions"
  ).Value = 0;
  zeroRaids.profile.scavStats.eft.overAllCounters.Items[0].Value = 0;
  assert.equal(validateSeasonalProfile(zeroRaids, options).code, "no_completed_raids");
});

test("runtime validation rejects malformed counters and timestamps", async () => {
  const payload = await loadFixture("seasonal-profile-section.json");
  const options = { ...baseOptions, confirmedContract: "profile_section" };

  const negativeCounter = structuredClone(payload);
  negativeCounter.seasonal.profile.pmcStats.eft.overAllCounters.Items[0].Value = -1;
  assert.equal(validateSeasonalProfile(negativeCounter, options).code, "invalid_payload");

  const invalidTimestamp = structuredClone(payload);
  invalidTimestamp.seasonal.profile.updated = "yesterday";
  assert.equal(validateSeasonalProfile(invalidTimestamp, options).code, "invalid_payload");

  const invalidSkillTimestamp = structuredClone(payload);
  invalidSkillTimestamp.seasonal.profile.skills.Common[0].LastAccess = "1783587000";
  assert.equal(validateSeasonalProfile(invalidSkillTimestamp, options).code, "invalid_payload");

  const zeroAid = structuredClone(payload);
  zeroAid.aid = 0;
  assert.equal(validateSeasonalProfile(zeroAid, options).code, "invalid_payload");

  const impossibleSurvival = structuredClone(payload);
  impossibleSurvival.seasonal.profile.pmcStats.eft.overAllCounters.Items.find(
    (item) => item.Key.includes("Survived")
  ).Value = 5;
  assert.equal(validateSeasonalProfile(impossibleSurvival, options).code, "invalid_payload");

  const impossibleKills = structuredClone(payload);
  impossibleKills.seasonal.profile.pmcStats.eft.overAllCounters.Items.find(
    (item) => item.Key[0] === "KilledPmc"
  ).Value = 10;
  assert.equal(validateSeasonalProfile(impossibleKills, options).code, "invalid_payload");

  const profileUpdatedBeforeCycle = structuredClone(payload);
  profileUpdatedBeforeCycle.seasonal.profile.updated = baseOptions.seasonStartsAt - 1;
  assert.equal(
    validateSeasonalProfile(profileUpdatedBeforeCycle, options).code,
    "outside_season"
  );
});
