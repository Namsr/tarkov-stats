/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- node:sqlite types are not present in the project's Node 20 type package.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { initializeSeasonalSchema } from "../lib/seasonal/storage.ts";

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

    const { getSeasonalAverageCrossSectionQuery, getSeasonalAchievementBaseline, getSeasonalRiskBaseline } = await import("../lib/seasonal/average-db.ts");
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

    const riskBaseline = await getSeasonalRiskBaseline("s1", 0, 50);
    assert.equal(riskBaseline?.n, 2);
    assert.equal(riskBaseline?.metrics.pmc_survival_rate?.n, 2);

    // Mutating only the copied PvP enrichment must not alter Seasonal combat.
    const update = new DatabaseSync(databasePath);
    update.prepare("UPDATE player_profiles SET lifetime_pvp_hours = 999, linked_pvp_achievements = '[\"ach-b\"]' WHERE mode = 'seasonal' AND cycle_id = 's1' AND aid = 1").run();
    update.close();
    const afterEnrichment = await query({ cycleId: "s1", period: "all", statistic: "median", dimension: "hours", metric: "players", min: null, max: null, now });
    assert.equal(afterEnrichment?.averages?.total_kills, all.averages?.total_kills);
  } finally {
    if (previousPath === undefined) delete process.env.PROGRESSION_SQLITE_PATH;
    else process.env.PROGRESSION_SQLITE_PATH = previousPath;
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* SQLite keeps the adapter open for this process. */ }
  }
});
