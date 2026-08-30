/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- node:sqlite types are not present in the project's Node 20 type package.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { initializeSeasonalSchema } from "../lib/seasonal/storage.ts";

test("Seasonal cohort reads the latest snapshot only from the requested cycle", async () => {
  const directory = mkdtempSync(join(tmpdir(), "seasonal-cohort-"));
  const databasePath = join(directory, "progression.db");
  const previousPath = process.env.PROGRESSION_SQLITE_PATH;
  process.env.PROGRESSION_SQLITE_PATH = databasePath;
  try {
    const db = new DatabaseSync(databasePath);
    initializeSeasonalSchema(db);
    const profile = db.prepare(`INSERT INTO player_profiles (
      mode, cycle_id, aid, nickname, profile_updated_at, last_access_at, lifetime_pvp_hours,
      experience, pmc_raids, scav_raids, pmc_survived, pmc_deaths, pmc_kills, killed_pmc,
      first_seen_at, last_seen_at
    ) VALUES ('seasonal', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mode, cycle_id, aid) DO UPDATE SET
        nickname = excluded.nickname,
        profile_updated_at = excluded.profile_updated_at,
        last_access_at = excluded.last_access_at,
        lifetime_pvp_hours = excluded.lifetime_pvp_hours,
        experience = excluded.experience,
        pmc_raids = excluded.pmc_raids,
        scav_raids = excluded.scav_raids,
        pmc_survived = excluded.pmc_survived,
        pmc_deaths = excluded.pmc_deaths,
        pmc_kills = excluded.pmc_kills,
        killed_pmc = excluded.killed_pmc,
        last_seen_at = excluded.last_seen_at`);
    const snapshot = db.prepare(`INSERT INTO progression_snapshots (
      mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at, local_date,
      experience, total_raids, pmc_raids, scav_raids, survived, pmc_survived, deaths,
      pmc_deaths, pmc_kills, total_kills, killed_pmc, run_through, level, prestige,
      longest_win_streak, achv_count, achievements
    ) VALUES ('seasonal', ?, ?, ?, ?, ?, '2026-01-01', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    const add = (cycle: string, aid: number, updated: number, hours: number, raids: number) => {
      profile.run(cycle, aid, `p-${cycle}-${aid}`, updated, updated, hours, 100,
        raids, 0, raids, 1, raids, 0, updated, updated);
      snapshot.run(cycle, aid, updated, updated, updated, 100, raids, raids, 0,
        raids, 1, raids, 1, 1, raids, raids, 0, null, 10, 1, 5, "[]");
    };

    // The target has an older and a newer snapshot in cycle-a.
    add("cycle-a", 1, 1_000, 100, 5);
    add("cycle-a", 1, 2_000, 100, 20);
    for (let aid = 2; aid <= 21; aid += 1) add("cycle-a", aid, 2_000 + aid, 100, 20);

    // Same account and same-looking cohort in another cycle must not leak in.
    add("cycle-b", 1, 9_000, 900, 90);
    for (let aid = 22; aid <= 41; aid += 1) add("cycle-b", aid, 9_000 + aid, 100, 20);
    db.close();

    const { querySeasonalComparisonCohort } = await import("../lib/seasonal/comparison-cohort.ts");
    const lookup = await querySeasonalComparisonCohort({
      aid: 1,
      cycleId: "cycle-a",
      now: 10_000,
    });
    assert.equal(lookup.available, true);
    assert.ok(lookup.result);
    assert.deepEqual(lookup.result.identity, { aid: 1, mode: "seasonal", cycleId: "cycle-a" });
    assert.equal(lookup.result.axes.hours.center, 100);
    assert.equal(lookup.result.axes.pmcRaids.center, 20);
    assert.equal(lookup.result.percent, 10);
    assert.equal(lookup.result.n, 20);
    assert.deepEqual(lookup.result.actualRanges, {
      hours: { min: 100, max: 100 },
      pmcRaids: { min: 20, max: 20 },
      raids: { min: 20, max: 20 },
    });
    assert.equal(lookup.result.ranges.hours.percent, 10);
    assert.equal(lookup.result.ranges.pmcRaids.percent, 10);
    assert.deepEqual(lookup.result.averages.kd_ratio, { value: 1, count: 20 });
    assert.deepEqual(lookup.result.averages.pmc_survival_rate, { value: 5, count: 20 });

    const median = await querySeasonalComparisonCohort({
      aid: 1,
      cycleId: "cycle-a",
      statistic: "median",
      now: 10_000,
    });
    assert.equal(median.result?.averages.kd_ratio.value, 1);
  } finally {
    if (previousPath === undefined) delete process.env.PROGRESSION_SQLITE_PATH;
    else process.env.PROGRESSION_SQLITE_PATH = previousPath;
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* SQLite may retain the adapter briefly. */ }
  }
});
