/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript test runner requires explicit .ts imports.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { findProfileSummary, type ProfileSummaryMode } from "../lib/profile-summary.ts";
import {
  buildRegularComparisonStats,
  buildSeasonalComparisonStats,
} from "../lib/profile-comparison.ts";

const profileRouteSource = await readFile(
  new URL("../app/api/player/profile/route.ts", import.meta.url),
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

test("radar comparison projection keeps all six regular metrics", () => {
  const comparison = buildRegularComparisonStats({
    hoursPlayed: 1200,
    pmcRaids: 400,
    kdRatio: 5.5,
    pmcKdRatio: 1.75,
    killsPerRaid: 3.25,
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
    pmcSurvivalRate: 60,
    longestWinStreak: 9,
    level: null,
  });
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
  assert.match(profileRouteSource, /getAchievements\("seasonal"\)\.catch\(\(\) => new Map\(\)\)/);
  assert.match(profileRouteSource, /comparisonStats: buildRegularComparisonStats\(stats\)/);
  assert.match(profileRouteSource, /comparisonStats: buildSeasonalComparisonStats\(result\.profile\)/);
  assert.match(profileRouteSource, /getPublishedSeasonalAchievementBaseline/);
  assert.doesNotMatch(profileRouteSource, /getSeasonalAchievementBaseline/);
});
