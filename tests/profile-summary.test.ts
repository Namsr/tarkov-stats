/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript test runner requires explicit .ts imports.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { findProfileSummary, type ProfileSummaryMode } from "../lib/profile-summary.ts";
import {
  buildPersistentComparisonStats,
  buildRegularComparisonStats,
  buildSeasonalComparisonStats,
} from "../lib/profile-comparison.ts";
import { seasonalKdRatio } from "../lib/seasonal/ui.ts";
import type { SeasonalProfile } from "../types/seasonal.ts";

const profileRouteSource = await readFile(
  new URL("../app/api/player/profile/route.ts", import.meta.url),
  "utf8",
);
const profileViewSource = await readFile(
  new URL("../lib/player-profile-view.ts", import.meta.url),
  "utf8",
);

test("profile summary uses regular, PVE, Arena priority and excludes unavailable mode", async () => {
  const calls: ProfileSummaryMode[] = [];
  const summary = await findProfileSummary(42, "pve", async (mode, aid) => {
    calls.push(mode);
    assert.equal(aid, 42);
    return mode === "arena" ? { nickname: "Arena", side: "Bear", prestige: 2 } : null;
  });

  assert.deepEqual(calls, ["regular", "arena"]);
  assert.deepEqual(summary, { nickname: "Arena", side: "Bear", prestige: 2 });
});

test("profile summary stops at the first saved snapshot", async () => {
  const calls: ProfileSummaryMode[] = [];
  const summary = await findProfileSummary(42, "arena", async (mode) => {
    calls.push(mode);
    return { nickname: mode };
  });

  assert.deepEqual(calls, ["regular"]);
  assert.deepEqual(summary, { nickname: "regular" });
});

test("profile summary is absent when no other mode snapshot exists", async () => {
  const summary = await findProfileSummary(42, "arena", async (mode) => {
    if (mode === "regular") throw new Error("store unavailable");
    return null;
  });

  assert.equal(summary, null);
});

test("radar comparison projection keeps regular metrics and the exact PMC kills rate", () => {
  const comparison = buildRegularComparisonStats({
    hoursPlayed: 1200,
    pmcRaids: 400,
    kdRatio: 5.5,
    pmcKdRatio: 1.75,
    killsPerRaid: 3.25,
    pmcKilledPmc: 200,
    pvpStatsVersion: 1,
    pmcSurvivalRate: 54,
    longestWinStreak: 11,
    level: 48,
    pvpStatsKnown: true,
  });

  assert.deepEqual(comparison, {
    hoursPlayed: 1200,
    pmcRaids: 400,
    kdRatio: 5.5,
    pmcKdRatio: 1.75,
    killsPerRaid: 3.25,
    killedPmcPerRaid: 0.5,
    pmcSurvivalRate: 54,
    longestWinStreak: 11,
    level: 48,
    pvpStatsKnown: true,
  });
});

test("radar comparison projection derives missing Seasonal metrics", () => {
  const comparison = buildSeasonalComparisonStats({
    aid: 42,
    mode: "seasonal",
    cycleId: "season-a",
    nickname: "Favorite",
    profileUpdatedAt: 1,
    lastAccessAt: 1,
    lifetimePvpHours: 2400,
    counters: {
      experience: 1_000_000,
      pmcRaids: 100,
      scavRaids: 20,
      pmcSurvived: 60,
      pmcDeaths: 40,
      pmcKills: 300,
      killedPmc: 80,
    },
    staticSignals: { prestige: 1, longestWinStreak: 9, achievementIds: [] },
  });

  assert.deepEqual(comparison, {
    hoursPlayed: 2400,
    pmcRaids: 100,
    kdRatio: 7.5,
    pmcKdRatio: 2,
    killsPerRaid: 3,
    killedPmcPerRaid: null,
    pmcSurvivalRate: 60,
    longestWinStreak: 9,
    level: null,
  });
});

test("exact PMC kills per raid rejects legacy counters, bad versions and zero raids in both projections", () => {
  const counters = { pmcRaids: 10, pmcKilledPmc: 5, killedPmc: 900, pmcKills: 900 };
  for (const [patch, expected] of [
    [{}, 0.5], [{ pmcKilledPmc: 0 }, 0], [{ pmcKilledPmc: null }, null],
    [{ pmcKilledPmc: undefined }, null], [{ pmcRaids: 0 }, null],
    [{ pvpStatsVersion: 0 }, null], [{ pvpStatsVersion: undefined }, null],
    [{ pvpStatsVersion: 2 }, null], [{ pmcKilledPmc: -1 }, null],
    [{ pmcKilledPmc: Infinity }, null], [{ pmcRaids: NaN }, null],
  ]) {
    const data = { ...counters, pvpStatsVersion: 1, ...patch };
    assert.equal(buildPersistentComparisonStats({ ...data, pmcKillsPerRaid: 90 }).killedPmcPerRaid, expected);
    assert.equal(buildSeasonalComparisonStats({ counters: data, pvpStatsVersion: data.pvpStatsVersion }).killedPmcPerRaid, expected);
  }
  assert.equal(buildPersistentComparisonStats({ ...counters, pvpStatsVersion: 1, pvpStatsKnown: false }).killedPmcPerRaid, null);
});

test("seasonal comparison never divides a total kill count by PMC-only deaths", () => {
  const profile: SeasonalProfile = {
    aid: 42,
    mode: "seasonal",
    cycleId: "season-a",
    nickname: "Favorite",
    profileUpdatedAt: 1,
    lastAccessAt: 1,
    lifetimePvpHours: 2400,
    counters: {
      experience: 1_000_000,
      pmcRaids: 100,
      scavRaids: 20,
      pmcSurvived: 60,
      pmcDeaths: 40,
      pmcKills: 500,
      killedPmc: 80,
    },
    // Scav Kills is present but Scav Deaths is missing, which is exactly when
    // parseSeasonalStats reports totalKills but leaves deaths and kdRatio null.
    seasonalStats: {
      totalRaids: 120,
      survivedRaids: null,
      totalKills: 560,
      deaths: null,
      runThrough: null,
      survivalRate: null,
      kdRatio: null,
      pmcKdRatio: 2,
      killsPerRaid: null,
      pmcSurvivalRate: 60,
      longestWinStreak: 9,
      level: null,
      prestige: 1,
      achievementsCount: null,
    },
    staticSignals: { prestige: 1, longestWinStreak: 9, achievementIds: [] },
  };

  // 560 / 40 would be reported, but 560 spans PMC+Scav and 40 is PMC-only, and
  // the parser already refused to compute a ratio for this profile.
  assert.equal(buildSeasonalComparisonStats(profile).kdRatio, null);
  // The PMC-only ratio is still available under its own field.
  assert.equal(buildSeasonalComparisonStats(profile).pmcKdRatio, 2);

  // With no Seasonal stats at all the PMC-only derivation still applies.
  const withoutStats: SeasonalProfile = { ...profile, seasonalStats: undefined };
  assert.equal(buildSeasonalComparisonStats(withoutStats).kdRatio, 12.5);

  // The client's own projection has to agree, so it calls the same helper. It
  // feeds the current player's dot in the same radar chart, so a second copy of
  // the rule would show 12.5 next to the favourite's "—" for one profile.
  assert.equal(seasonalKdRatio(profile.seasonalStats, profile.counters), null);
  assert.equal(seasonalKdRatio(withoutStats.seasonalStats, withoutStats.counters), 12.5);
});

test("mode-scoped profile responses carry identity and keep optional summaries additive", () => {
  assert.match(
    profileRouteSource,
    /identity: \{ aid, mode, cycleId \}[\s\S]*?code: "mode_profile_unavailable"/,
  );
  assert.match(
    profileRouteSource,
    /NextResponse\.json\(\s*\{ error: "Rate limit exceeded" \},\s*\{ status: 429/,
  );
  assert.ok(
    profileRouteSource.indexOf('const aid = parsePlayerId(request.nextUrl.searchParams.get("aid") ?? "")') <
      profileRouteSource.indexOf('getRateLimitHeaders(ip, { bucket: "profile", max: 10 })'),
    "profile AID must be parsed before the rate limiter records a 429",
  );
  assert.match(profileRouteSource, /timing\.setRequestContext\(\{[\s\S]*?aid: aid \?\? undefined,[\s\S]*?\}\);/);
  assert.match(
    profileRouteSource,
    /NextResponse\.json\(\{ error: "Failed to load player profile" \}, \{ status: 503/,
  );
  assert.match(
    profileRouteSource,
    /\{ error: "Failed to fetch player profile", identity: \{ aid, mode, cycleId \} \},\s*\{ status: 502/,
  );
  assert.match(profileRouteSource, /viewModel: buildRegularProfileViewModel/);
  assert.match(profileRouteSource, /const enrichedSeasonalViewModel = result\.ok[\s\S]*?await enrichSeasonalViewModel/);
  assert.match(profileRouteSource, /viewModel: enrichedSeasonalViewModel/);
  assert.match(profileRouteSource, /comparisonStats: buildRegularComparisonStats\(stats\)/);
  assert.match(profileRouteSource, /comparisonStats: buildSeasonalComparisonStats\(result\.profile\)/);
  assert.match(profileRouteSource, /getPublishedSeasonalAchievementBaseline/);
  assert.doesNotMatch(profileRouteSource, /getSeasonalAchievementBaseline/);
});

test("profile achievement fallbacks sanitize images and prefer BSG adjusted completion", () => {
  assert.match(profileViewSource, /imageUrl: safeAchievementImageUrl\(row\.imageUrl \?\? row\.imageLink\)/);
  assert.match(profileRouteSource, /safeAchievementImageUrl\(meta\?\.imageUrl \?\? achievement\.imageUrl\)/g);
  assert.match(
    profileRouteSource,
    /officialPercentage: meta\?\.adjustedPlayersCompletedPercent\s*\n\s*\?\? meta\?\.playersCompletedPercent\s*\n\s*\?\? null/,
  );
});
