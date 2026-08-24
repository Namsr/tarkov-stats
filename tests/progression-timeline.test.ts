/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's native TypeScript runner does not type-check test fixtures.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

// @ts-expect-error Node's strip-types test runner requires the extension.
import {
  buildProgressionMetricSeries,
  parseProgressionTimelineRequest,
} from "../lib/seasonal/progression.ts";
// @ts-expect-error Node's strip-types test runner requires the extension.
import {
  DAY_MS,
  buildSequentialIntervals,
  calculateKd,
} from "../lib/seasonal/analytics.ts";
// @ts-expect-error Node's strip-types test runner requires the extension.
import { PROGRESSION_METRIC_KEYS } from "../types/seasonal.ts";
// @ts-expect-error Node's strip-types test runner requires the extension.
import {
  progressionLineSegments,
  progressionRaidDomain,
  progressionValueDomain,
} from "../lib/seasonal/progression-timeline-ui.ts";
// @ts-expect-error Node's strip-types test runner requires the extension.
import { initializeSeasonalSchema } from "../lib/seasonal/storage.ts";

const execFileAsync = promisify(execFile);

const identity = { mode: "seasonal", cycleId: "s1", aid: 1 } as const;

function row(overrides = {}) {
  return {
    aid: 1,
    point_id: 1,
    local_date: "2026-01-01",
    observed_at: DAY_MS,
    value: 10,
    pmc_raids: 11,
    raid_bucket: 20,
    lifetime_hours: 100,
    freshness_at: DAY_MS,
    confidence: 1,
    series_id: 1,
    ...overrides,
  };
}

function counters(overrides = {}) {
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

function point(pmcRaids: number, value: number, seriesId: number | null = 1) {
  return {
    pointId: `${pmcRaids}:${value}`,
    date: "2026-01-01",
    observedAt: null,
    pmcRaids,
    value,
    seriesId,
    p25: null,
    p75: null,
    n: 1,
    sampleN: null,
    preliminary: false,
    confidence: 1,
  };
}

test("timeline request parser enforces one valid profile identity", () => {
  assert.deepEqual(
    parseProgressionTimelineRequest(new URLSearchParams("mode=regular&cycle=persistent&aid=42")),
    { mode: "regular", cycleId: "persistent", aid: 42 },
  );
  assert.deepEqual(
    parseProgressionTimelineRequest(new URLSearchParams("mode=pve&cycle=persistent&aid=42")),
    { mode: "pve", cycleId: "persistent", aid: 42 },
  );
  assert.deepEqual(
    parseProgressionTimelineRequest(new URLSearchParams("mode=seasonal&cycle=s1&aid=42")),
    { mode: "seasonal", cycleId: "s1", aid: 42 },
  );

  for (const query of [
    "mode=seasonal&cycle=s1",
    "mode=seasonal&cycle=s1&aid=42&aid=43",
    "mode=seasonal&cycle=s1&aid=42&kind=tempo",
    "mode=regular&cycle=s1&aid=42",
    "mode=pve&cycle=s1&aid=42",
    "mode=seasonal&cycle=persistent&aid=42",
    "mode=seasonal&cycle=s1&aid=0",
    "mode=seasonal&cycle=s1&aid=1.5",
    "mode=seasonal&cycle=s1&aid=9007199254740992",
    "mode=seasonal&cycle=bad%20cycle&aid=42",
  ]) {
    assert.equal(parseProgressionTimelineRequest(new URLSearchParams(query)), null, query);
  }
});

test("timeline route returns the combined response and keeps mode-specific caching", async () => {
  const source = await readFile("app/api/progression/timeline/route.ts", "utf8");
  assert.match(source, /parseProgressionTimelineRequest\(request\.nextUrl\.searchParams\)/);
  assert.match(source, /NextResponse\.json\(result\.timeline/);
  assert.match(source, /PROGRESSION_CACHE_CONTROL/);
  assert.match(source, /getCachedProgressionTimeline\(input\.mode, input\.cycleId, input\.aid\)/);
  assert.doesNotMatch(source, /input\.mode === "regular"[\s\S]*?private, no-store/);
});

test("regular timeline reads an initialized SQLite database without waiting for a writer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "progression-read-"));
  const databasePath = join(directory, "progression.db");
  const db = new DatabaseSync(databasePath);
  try {
    initializeSeasonalSchema(db);
    db.prepare(`INSERT INTO progression_snapshots (
      mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at, local_date,
      experience, pmc_raids, scav_raids, pmc_survived, pmc_deaths, pmc_kills, killed_pmc
    ) VALUES ('regular', 'persistent', 2203669, 1, 1, 1, '2026-08-18', 1, 1, 0, 0, 0, 0, 0)`).run();
    db.exec("BEGIN IMMEDIATE");

    const startedAt = performance.now();
    const { stdout } = await execFileAsync(process.execPath, [
      "--experimental-strip-types",
      "--experimental-sqlite",
      "-e",
      `import('./lib/seasonal/progression-db.ts').then(async ({ getProgressionTimelineRevisions }) => {
        console.log(JSON.stringify(await getProgressionTimelineRevisions({ mode: 'regular', cycleId: 'persistent', aid: 2203669 })));
      })`,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, PROGRESSION_SQLITE_PATH: databasePath },
      timeout: 2_000,
    });
    assert.ok(performance.now() - startedAt < 2_000, "read path should not wait on schema DDL locks");
    assert.deepEqual(JSON.parse(stdout.trim()), { personalRevision: 1, populationGeneration: 0 });
  } finally {
    try { db.exec("ROLLBACK"); } catch {}
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("regular timeline read initializes a fresh SQLite database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "progression-fresh-"));
  const databasePath = join(directory, "progression.db");
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      "--experimental-strip-types",
      "--experimental-sqlite",
      "-e",
      `import('./lib/seasonal/progression-db.ts').then(async ({ getProgressionTimelineRevisions }) => {
        console.log(JSON.stringify(await getProgressionTimelineRevisions({ mode: 'regular', cycleId: 'persistent', aid: 2203669 })));
      })`,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, PROGRESSION_SQLITE_PATH: databasePath },
      timeout: 5_000,
    });
    assert.deepEqual(JSON.parse(stdout.trim()), { personalRevision: 0, populationGeneration: 0 });
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM player_profiles").get().n, 0);
    } finally {
      db.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("timeline exposes ten unique selectable metrics and a stable per-metric series shape", () => {
  assert.equal(PROGRESSION_METRIC_KEYS.length, 10);
  assert.equal(new Set(PROGRESSION_METRIC_KEYS).size, PROGRESSION_METRIC_KEYS.length);
  assert.deepEqual(PROGRESSION_METRIC_KEYS, [
    "xp",
    "xp_per_day",
    "pmc_raids_per_day",
    "pmc_kills_per_day",
    "non_pmc_kills_per_day",
    "survival",
    "pvp_kd",
    "ai_kd",
    "pmc_kills_per_raid",
    "non_pmc_kills_per_raid",
  ]);

  const source = Array.from({ length: 100 }, (_, index) => row({
    aid: index + 1,
    point_id: index + 1,
    value: index === 0 ? 10 : 20,
    freshness_at: DAY_MS + index,
    observed_at: DAY_MS + index,
  }));
  const series = buildProgressionMetricSeries(source, identity, "pvp_kd");
  assert.deepEqual(Object.keys(series).sort(), ["confidence", "freshnessAt", "n", "nearby", "overall", "player"]);
  assert.match(series.player[0].pointId, /^pvp_kd:/);
  assert.equal(series.player[0].value, 10);
  assert.equal(series.overall[0].value, 20);
  assert.equal(series.overall[0].n, 100);
  assert.equal(series.nearby[0].value, 20);
});

test("nearby metric cohorts use the trimmed mean and preserve raid coordinates", () => {
  const source = [row({ aid: 1, point_id: 1, value: 0 })];
  for (let aid = 2; aid <= 31; aid += 1) {
    source.push(row({
      aid,
      point_id: aid,
      value: aid === 31 ? 1_000 : 10,
      freshness_at: DAY_MS + aid,
      observed_at: DAY_MS + aid,
    }));
  }
  const series = buildProgressionMetricSeries(source, identity, "pvp_kd");
  assert.equal(series.nearby.length, 1);
  assert.equal(series.nearby[0].value, 10, "5% trimming removes the extreme high value");
  assert.deepEqual(
    { min: series.nearby[0].raidMin, max: series.nearby[0].raidMax, n: series.nearby[0].n },
    { min: 11, max: 20, n: 30 },
  );
});

test("progression points preserve the resolved level for the chart axis", () => {
  const series = buildProgressionMetricSeries([
    row({ point_id: 1, value: 1_000, pmc_raids: 10, level: 26 }),
  ], identity, "xp");
  assert.equal(series.player[0].level, 26);
});

test("interval-derived timeline metrics normalize elapsed days and zero-death K/D", () => {
  const intervals = buildSequentialIntervals([
    { profileUpdatedAt: DAY_MS, counters: counters() },
    {
      profileUpdatedAt: 3 * DAY_MS,
      counters: counters({
        experience: 4_000,
        pmcRaids: 4,
        pmcSurvived: 3,
        pmcKills: 6,
        killedPmc: 2,
      }),
    },
  ]);
  const metrics = intervals[0].metrics;
  assert.equal(intervals[0].status, "valid");
  assert.deepEqual({
    xpPerDay: metrics.xpPerDay,
    pmcRaidsPerDay: metrics.pmcRaidsPerDay,
    killedPmcPerDay: metrics.killedPmcPerDay,
    nonPmcKillsPerDay: metrics.nonPmcKillsPerDay,
    survivalRate: metrics.survivalRate,
    pvpKd: metrics.pvpKd,
    aiScavKd: metrics.aiScavKd,
    killedPmcPerRaid: metrics.killedPmcPerRaid,
    nonPmcKillsPerRaid: metrics.nonPmcKillsPerRaid,
  }, {
    xpPerDay: 2_000,
    pmcRaidsPerDay: 2,
    killedPmcPerDay: 1,
    nonPmcKillsPerDay: 2,
    survivalRate: 0.75,
    pvpKd: 2,
    aiScavKd: 4,
    killedPmcPerRaid: 0.5,
    nonPmcKillsPerRaid: 1,
  });
  assert.deepEqual(calculateKd(counters({ pmcKills: 12, killedPmc: 5, pmcDeaths: 0 })), {
    pvpKd: 5,
    aiScavKd: 7,
    overallPmcKd: 12,
  });
});

test("intervals without PMC raids leave per-raid metrics missing instead of inventing zeroes", () => {
  const interval = buildSequentialIntervals([
    { profileUpdatedAt: DAY_MS, counters: counters() },
    { profileUpdatedAt: 2 * DAY_MS, counters: counters({ experience: 100, scavRaids: 2 }) },
  ])[0];
  assert.equal(interval.status, "valid");
  assert.equal(interval.metrics?.survivalRate, null);
  assert.equal(interval.metrics?.killedPmcPerRaid, null);
  assert.equal(interval.metrics?.nonPmcKillsPerRaid, null);
  assert.equal(interval.hasTempo, false);
  assert.equal(interval.hasForm, false);
});

test("invalid values are omitted and reset series remain visually disconnected", () => {
  const source = [
    row({ aid: 1, point_id: 1, value: 10, series_id: 1 }),
    row({ aid: 1, point_id: 2, value: Number.NaN, series_id: 1, freshness_at: DAY_MS + 1 }),
    row({ aid: 1, point_id: 3, value: 5, series_id: 2, freshness_at: DAY_MS + 2 }),
  ];
  const series = buildProgressionMetricSeries(source, identity, "xp");
  assert.deepEqual(series.player.map((item) => item.value), [10, 5]);
  assert.deepEqual(series.player.map((item) => item.seriesId), [1, 2]);
  assert.deepEqual(
    progressionLineSegments(series.player).map((segment) => segment.map((item) => item.value)),
    [[10], [5]],
  );
});

test("focused raid bounds and independent metric domains keep close changes readable", () => {
  assert.deepEqual(
    progressionRaidDomain([point(20, 1), point(2_000, 2)], [point(1_000, 100), point(1_050, 102)], true),
    { min: 990, max: 1_060 },
  );
  assert.deepEqual(progressionRaidDomain([], [], true), { min: 0, max: 10 });
  assert.deepEqual(progressionValueDomain([point(1, 100), point(2, 102)]), { min: 99.84, max: 102.16 });
  assert.deepEqual(progressionValueDomain([point(1, 140), point(2, 180)], true), { min: 92, max: 100 });
  assert.deepEqual(progressionValueDomain([point(1, 4), point(2, 4)]), { min: 3, max: 5 });
});
