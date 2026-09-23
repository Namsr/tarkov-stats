/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- node:sqlite types are not present in the project's Node 20 type package.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { initializeSeasonalSchema } from "../lib/seasonal/storage.ts";
import { scoreSeasonalCheater } from "../lib/cheater-score.ts";

test("Seasonal cross-section keeps cycle, snapshot, freshness, and enrichment boundaries", async () => {
  const directory = mkdtempSync(join(tmpdir(), "seasonal-average-"));
  const databasePath = join(directory, "progression.db");
  const previousPath = process.env.PROGRESSION_SQLITE_PATH;
  process.env.PROGRESSION_SQLITE_PATH = databasePath;
  try {
    const db = new DatabaseSync(databasePath);
    initializeSeasonalSchema(db);
    const now = 1_800_000_000_000;
    db.prepare("INSERT INTO season_cycles (mode, cycle_id, starts_at, enabled) VALUES ('seasonal', ?, ?, 1)")
      .run("s1", now - 200 * 86_400_000);
    db.prepare("INSERT INTO season_cycles (mode, cycle_id, starts_at, enabled) VALUES ('seasonal', ?, ?, 1)")
      .run("s2", now - 200 * 86_400_000);
    const profile = db.prepare(`INSERT INTO player_profiles (
      mode, cycle_id, aid, nickname, profile_updated_at, last_access_at, lifetime_pvp_hours,
      experience, pmc_raids, scav_raids, pmc_survived, pmc_deaths, pmc_kills, killed_pmc,
      first_seen_at, last_seen_at, confirmed_banned
    ) VALUES ('seasonal', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const snapshot = db.prepare(`INSERT INTO progression_snapshots (
      mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at, local_date,
      experience, total_raids, pmc_raids, scav_raids, survived, pmc_survived, deaths,
      pmc_deaths, pmc_kills, total_kills, killed_pmc, run_through, level, prestige,
      longest_win_streak, achv_count, achievements
    ) VALUES ('seasonal', ?, ?, ?, ?, ?, '2026-01-01', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const add = (aid, updated, hours, raids, kills, banned = 0, cycle = "s1") => {
      profile.run(cycle, aid, `p-${aid}`, updated, updated, hours, 100, raids, 0, raids, 1, kills, 0, updated, updated, banned);
      const achievements = aid <= 2
        ? JSON.stringify([{ id: "ach-a", unlockedAt: now - 10 * 86_400_000 }])
        : "[]";
      snapshot.run(cycle, aid, updated, updated, updated, 100, raids, raids, 0, 1, raids, 1, 1, kills, kills, 0, null, null, null, null, null, achievements);
    };
    add(1, now - 1_000, 10, 10, 4);
    add(2, now - 90 * 86_400_000, 20, 20, 8); // exact cutoff is included
    add(3, now - 1_000, 30, 30, 12, 1);
    add(4, now - 1_000, 40, 40, 16, 0, "s2");
    db.prepare(`UPDATE player_profiles SET linked_pvp_achievements = ?, linked_pvp_profile_updated_at = ?
      WHERE mode = 'seasonal' AND cycle_id = 's1' AND aid IN (1, 2)`)
      .run('["ach-a"]', now);
    db.close();

    const { getSeasonalAverageCrossSectionQuery, getSeasonalAchievementBaseline, getSeasonalRiskBaseline, selectSeasonalRiskPercent } = await import("../lib/seasonal/average-db.ts");
    const query = await getSeasonalAverageCrossSectionQuery();
    assert.ok(query);
    const all = await query({ cycleId: "s1", period: "all", statistic: "median", dimension: "hours", metric: "players", min: null, max: null, now });
    assert.ok(all);
    assert.equal(all.total, 2);
    assert.equal(all.averages?.n, 2);
    assert.equal(all.averages?.pmc_raids, 15);
    assert.equal(all.averages?.total_kills, 6);
    assert.equal(all.buckets.reduce((sum, bucket) => sum + bucket.n, 0), 2);
    assert.equal(all.cycleId, "s1");

    const medianDistribution = await query({
      cycleId: "s1", period: "all", statistic: "median", dimension: "hours",
      metric: "total_kills", min: null, max: null, now,
    });
    assert.ok(medianDistribution);
    assert.equal(medianDistribution.buckets.reduce((sum, bucket) => sum + bucket.n, 0), 2);

    const fresh = await query({ cycleId: "s1", period: "90d", statistic: "trimmed_mean", dimension: "pmc_raids", metric: "players", min: 20, max: 20, now });
    assert.ok(fresh);
    assert.equal(fresh.total, 2); // the profile exactly on the 90-day cutoff is included
    assert.equal(fresh.averages?.n, 1);
    assert.equal(fresh.averages?.pmc_raids, 20);

    const baseline = await getSeasonalAchievementBaseline("s1");
    assert.equal(baseline?.total, 2);
    assert.equal(baseline?.eligibleN, 2);
    assert.equal(baseline?.seasonStartsAt, now - 200 * 86_400_000);
    assert.deepEqual(baseline?.achievements.map((row) => row.ach_id), ["ach-a"]);
    assert.equal(baseline?.achievements[0]?.owners, 2);
    assert.equal(baseline?.achievements[0]?.prevalencePct, 100);
    assert.equal(baseline?.achievements[0]?.unlockDayP20, 190);

    const riskFixture = new DatabaseSync(databasePath);
    const riskProfile = riskFixture.prepare(`INSERT INTO player_profiles (
      mode, cycle_id, aid, nickname, profile_updated_at, last_access_at, lifetime_pvp_hours,
      experience, pmc_raids, scav_raids, pmc_survived, pmc_deaths, pmc_kills, killed_pmc,
      total_raids, survived, deaths, total_kills, longest_win_streak, level,
      first_seen_at, last_seen_at, confirmed_banned
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const riskSnapshot = riskFixture.prepare(`INSERT INTO progression_snapshots (
      mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at, local_date,
      experience, total_raids, pmc_raids, scav_raids, survived, pmc_survived, deaths,
      pmc_deaths, pmc_kills, total_kills, killed_pmc, run_through, level, prestige,
      longest_win_streak, achv_count, achievements
    ) VALUES (?, ?, ?, ?, ?, ?, '2026-01-01', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const addRiskPlayer = (aid, cycle, hours, raids, banned = 0) => {
      const updated = now - 1_000;
      const survived = Math.floor(raids * 0.5);
      riskProfile.run("seasonal", cycle, aid, `risk-${aid}`, updated, updated, hours, 100, raids, 0,
        survived, 1, raids * 2, raids, raids, survived, 1, raids, 5, 10, updated, updated, banned);
      riskSnapshot.run("seasonal", cycle, aid, updated, updated, updated, 100, raids, raids, 0,
        survived, survived, 1, raids * 2, raids * 2, raids, raids, 0, 10, 1, 5, 5, "[]");
    };
    addRiskPlayer(5, "s1", 100, 5);
    for (let aid = 100; aid <= 134; aid += 1) addRiskPlayer(aid, "s1", 1_000, 100);
    addRiskPlayer(200, "s1", 100, 5, 1);
    addRiskPlayer(201, "s1", 100, 5);
    addRiskPlayer(202, "s2", 100, 5);
    riskFixture.prepare("INSERT INTO excluded_players (aid, reason, created_at) VALUES (201, 'admin_manual', ?)")
      .run(now);
    riskFixture.close();

    const riskBaseline = await getSeasonalRiskBaseline("s1", { hours: 100, pmcRaids: 5 }, 5);
    assert.equal(riskBaseline?.n, 37);
    assert.equal(riskBaseline?.metrics.pmc_survival_rate?.n, 37);
    for (const [counts, expected] of [
      [{ 10: 30, 15: 30, 20: 30, 30: 30 }, 10],
      [{ 10: 29, 15: 30, 20: 30, 30: 30 }, 15],
      [{ 10: 29, 15: 29, 20: 30, 30: 30 }, 20],
      [{ 10: 29, 15: 29, 20: 29, 30: 30 }, 30],
    ] as const) {
      assert.equal(selectSeasonalRiskPercent(counts), expected);
    }
    const riskAchievementBaseline = await getSeasonalAchievementBaseline("s1", 5);
    assert.equal(riskAchievementBaseline?.eligibleN, 37);
    const targetStats = {
      pmcRaids: 5,
      hoursPlayed: 100,
      pmcKdRatio: 20,
      pmcSurvivalRate: 50,
      pmcKillsPerRaid: 1,
      longestWinStreak: 5,
      prestige: 0,
    };
    const extreme = scoreSeasonalCheater(targetStats, riskBaseline, null);
    assert.ok(extreme.score > 0);
    const achievementEvidence = {
      ownedIds: ["seasonal-ach"],
      seasonal: true,
      playerUnlockDays: { "seasonal-ach": 0 },
      stats: [{
        id: "seasonal-ach",
        owners: 10,
        eligibleN: 30,
        samplePct: 0,
        meanHours: 0,
        earlyHours: 0,
        unlockDayP20: 10,
      }],
    };
    const zeroRaids = scoreSeasonalCheater({
      ...targetStats,
      pmcRaids: 0,
      pmcKdRatio: 100,
      pmcSurvivalRate: 100,
      pmcKillsPerRaid: 100,
      longestWinStreak: 100,
    }, riskBaseline, null);
    assert.equal(zeroRaids.score, 0);
    assert.equal(zeroRaids.tier, "low");
    const invalidMetrics = scoreSeasonalCheater({
      ...targetStats,
      pmcKdRatio: Number.NaN,
      pmcSurvivalRate: Number.NaN,
      pmcKillsPerRaid: Number.NaN,
      longestWinStreak: Number.NaN,
      prestige: Number.NaN,
    }, riskBaseline, achievementEvidence);
    assert.equal(invalidMetrics.score, 0);
    const missingMetrics = scoreSeasonalCheater({
      ...targetStats,
      pmcKdRatio: undefined,
    }, riskBaseline, achievementEvidence);
    assert.equal(missingMetrics.score, 0);
    const zeroHours = scoreSeasonalCheater({
      ...targetStats,
      hoursPlayed: 0,
    }, riskBaseline, achievementEvidence);
    assert.equal(zeroHours.score, 0);
    const sparse = scoreSeasonalCheater(targetStats, { ...riskBaseline, n: 0, metrics: {} }, null);
    assert.equal(Number.isFinite(sparse.score), true);

    // Mutating only the copied PvP enrichment must not alter Seasonal combat.
    const update = new DatabaseSync(databasePath);
    update.prepare("UPDATE player_profiles SET lifetime_pvp_hours = 999, linked_pvp_achievements = '[\"ach-b\"]' WHERE mode = 'seasonal' AND cycle_id = 's1' AND aid = 1").run();
    update.close();
    const afterEnrichment = await getSeasonalRiskBaseline("s1", { hours: 100, pmcRaids: 5 }, 5);
    assert.equal(afterEnrichment?.metrics.pmc_survival_rate?.mean, riskBaseline?.metrics.pmc_survival_rate?.mean);
  } finally {
    if (previousPath === undefined) delete process.env.PROGRESSION_SQLITE_PATH;
    else process.env.PROGRESSION_SQLITE_PATH = previousPath;
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* SQLite keeps the adapter open for this process. */ }
  }
});
