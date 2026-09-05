import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  isSeasonalUpstreamReady,
  parseSeasonalProfile,
  seasonalLastAccess,
  seasonalLeaderboardActivity,
  validateSeasonalProfile,
} from "../lib/seasonal-upstream.ts";
import { seasonalProfileCacheUrl } from "../lib/seasonal/profile-cache-key.ts";

const fixtures = new URL("./fixtures/", import.meta.url);
const loadFixture = async (name) =>
  JSON.parse(await readFile(new URL(name, fixtures), "utf8"));

const baseOptions = {
  enabled: true,
  cycleId: "season-2026-01",
  seasonStartsAt: 1_783_000_000_000,
  seasonEndsAt: 1_784_000_000_000,
};

test("uses a stable fifteen-minute profile cache key when no feed version is known", () => {
  const url = "https://players.tarkov.dev/pvp-season/730003.json";
  assert.equal(new URL(seasonalProfileCacheUrl(url, undefined, 0)).searchParams.get("v"), "0");
  assert.equal(
    seasonalProfileCacheUrl(url, undefined, 899_999),
    seasonalProfileCacheUrl(url, undefined, 0),
  );
  assert.equal(new URL(seasonalProfileCacheUrl(url, undefined, 900_000)).searchParams.get("v"), "1");
});

test("uses the exact feed version as the profile cache key", () => {
  const version = 1_785_969_007_540;
  const url = seasonalProfileCacheUrl(
    "https://players.tarkov.dev/pvp-season/730003.json?source=test",
    version,
    0,
  );
  assert.equal(new URL(url).searchParams.get("source"), "test");
  assert.equal(new URL(url).searchParams.get("v"), String(version));
});

test("explicit profile refresh bypasses the normal fifteen-minute cache slot", () => {
  const url = seasonalProfileCacheUrl(
    "https://players.tarkov.dev/pvp-season/730003.json",
    undefined,
    1_800_000_000_000,
    true,
  );
  assert.equal(new URL(url).searchParams.get("v"), "1800000000000");
});

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
  assert.deepEqual(profile.seasonalAchievements, [
    { id: "first_raid", unlockedAt: 1_783_495_000_000 },
  ]);
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

test("uses account time from the Seasonal JSON when linked PvP hours are missing", async () => {
  const payload = await loadFixture("seasonal-direct-profile.json");
  payload.pmcStats.eft.totalInGameTime = 4_836_316;
  payload.scavStats.eft.totalInGameTime = 4_836_316;

  const profile = parseSeasonalProfile(payload, {
    ...baseOptions,
    confirmedContract: "direct_profile",
    seasonStartsAt: 1_785_800_000_000,
    seasonEndsAt: null,
  });

  assert.equal(profile.lifetimePvpHours, 1_343.4);
});

test("accepts an empty achievements array as known absence but rejects non-empty arrays", async () => {
  const payload = await loadFixture("seasonal-game-mode.json");
  payload.profile.achievements = [];
  const profile = parseSeasonalProfile(payload, {
    ...baseOptions,
    confirmedContract: "game_mode",
  });
  assert.deepEqual(profile.seasonalAchievements, []);
  assert.deepEqual(profile.staticSignals?.achievementIds, []);
  assert.equal(profile.seasonalStats?.achievementsCount, 0);
  assert.equal(seasonalLastAccess(payload.profile), 1_783_500_000_000);

  const nonEmpty = structuredClone(payload);
  nonEmpty.profile.achievements = [1_783_500_000];
  assert.equal(validateSeasonalProfile(nonEmpty, {
    ...baseOptions,
    confirmedContract: "game_mode",
  }).code, "invalid_payload");

  const wrongType = structuredClone(payload);
  wrongType.profile.achievements = "none";
  assert.equal(validateSeasonalProfile(wrongType, {
    ...baseOptions,
    confirmedContract: "game_mode",
  }).code, "invalid_payload");
});

test("explicit linked PvP hours override the Seasonal account-time fallback", async () => {
  const payload = await loadFixture("seasonal-direct-profile.json");
  payload.pmcStats.eft.totalInGameTime = 4_836_316;

  const profile = parseSeasonalProfile(payload, {
    ...baseOptions,
    confirmedContract: "direct_profile",
    seasonStartsAt: 1_785_800_000_000,
    seasonEndsAt: null,
    lifetimePvpHours: 640.5,
  });

  assert.equal(profile.lifetimePvpHours, 640.5);
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

test("leaderboard inputs distinguish explicit zero from missing counters and require positive skill progress", async () => {
  const payload = await loadFixture("seasonal-game-mode.json");
  payload.profile.skills.Common = [
    { Id: "Ignored", Progress: 0, LastAccess: 1_783_500_100 },
    { Id: "Strength", Progress: 1, LastAccess: 1_783_500_000 },
    { Id: "Never", Progress: 5, LastAccess: -2147483648 },
  ];
  const killed = payload.profile.pmcStats.eft.overAllCounters.Items.find((item) => item.Key[0] === "KilledPmc");
  killed.Value = 0;
  const profile = parseSeasonalProfile(payload, { ...baseOptions, confirmedContract: "game_mode" });
  assert.equal(profile.counters.pmcKilledPmc, 0);
  assert.equal(profile.pvpStatsVersion, 1);
  assert.equal(profile.pvpStatsParserVersion, 1);
  assert.equal(profile.leaderboardActivityAt, 1_783_500_000_000);
  assert.equal(seasonalLeaderboardActivity(payload.profile), 1_783_500_000_000);

  for (const key of [["Sessions", "Pmc"], ["Deaths"], ["KilledPmc"]]) {
    const missing = structuredClone(payload);
    missing.profile.pmcStats.eft.overAllCounters.Items = missing.profile.pmcStats.eft.overAllCounters.Items
      .filter((item) => JSON.stringify(item.Key) !== JSON.stringify(key));
    if (key[0] === "Sessions") {
      missing.profile.pmcStats.eft.overAllCounters.Items = missing.profile.pmcStats.eft.overAllCounters.Items
        .filter((item) => item.Key[0] !== "ExitStatus");
    }
    const parsed = parseSeasonalProfile(missing, { ...baseOptions, confirmedContract: "game_mode" });
    assert.equal(parsed.pvpStatsVersion, 0);
    if (key[0] === "KilledPmc") assert.equal(parsed.counters.pmcKilledPmc, null);
  }
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

test("rejects a mismatched cycle and out-of-season activity while keeping zero-raid profiles", async () => {
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
  zeroRaids.profile.pmcStats.eft.overAllCounters.Items.forEach((item) => {
    if (item.Key[0] !== "Sessions") item.Value = 0;
  });
  zeroRaids.profile.scavStats.eft.overAllCounters.Items.forEach((item) => {
    if (item.Key[0] !== "Sessions") item.Value = 0;
  });
  const zeroRaidResult = validateSeasonalProfile(zeroRaids, options);
  assert.equal(zeroRaidResult.ok, true);
  assert.equal(zeroRaidResult.ok && zeroRaidResult.profile.counters.pmcRaids, 0);
  assert.equal(zeroRaidResult.ok && zeroRaidResult.profile.counters.scavRaids, 0);
  assert.equal(zeroRaidResult.ok && zeroRaidResult.profile.seasonalStats?.totalRaids, 0);
});

test("uses profile.updated for a fresh zero-raid profile without activity arrays", async () => {
  const payload = await loadFixture("seasonal-game-mode.json");
  delete payload.profile.skills;
  delete payload.profile.achievements;
  payload.profile.pmcStats.eft.overAllCounters.Items.find(
    (item) => item.Key[0] === "Sessions"
  ).Value = 0;
  payload.profile.scavStats.eft.overAllCounters.Items[0].Value = 0;
  payload.profile.pmcStats.eft.overAllCounters.Items.forEach((item) => {
    if (item.Key[0] !== "Sessions") item.Value = 0;
  });
  payload.profile.scavStats.eft.overAllCounters.Items.forEach((item) => {
    if (item.Key[0] !== "Sessions") item.Value = 0;
  });
  const result = validateSeasonalProfile(payload, {
    ...baseOptions,
    confirmedContract: "game_mode",
  });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.profile.lastAccessAt, result.ok && result.profile.profileUpdatedAt);
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
