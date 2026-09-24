/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- node:sqlite types are not present in the project's Node 20 type package.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
    }
    return nextResolve(specifier, context);
  },
});

const { createSqliteModerationStore } = await import("../lib/admin/moderation-db.ts");
const { ArenaRiskUnsupportedError, evaluateAndStoreRisk, riskScoreVersion } = await import("../lib/admin/risk-service.ts");
const { hasValidRiskInputs } = await import("../lib/cheater-score.ts");

const risk = (aid, mode, score, profileUpdatedAt = 10) => ({
  aid,
  mode,
  cycleId: "persistent",
  score,
  tier: score >= 80 ? "severe" : score >= 40 ? "high" : score >= 20 ? "medium" : "low",
  factors: [],
  scoreVersion: 1,
  profileUpdatedAt,
  evaluatedAt: 20,
});

function moderationDb() {
  const db = new DatabaseSync(":memory:");
  for (const schema of ["bans_db", "players_db", "progression_db", "reports_db"]) {
    db.exec(`ATTACH DATABASE ':memory:' AS ${schema}`);
  }
  return db;
}

test("legacy moderation ignores Arena risk rows", () => {
  const db = moderationDb();
  try {
    const store = createSqliteModerationStore(db, { attachExternal: false });
    store.saveRisk(risk(101, "arena", 100));

    assert.deepEqual(store.automaticSuspiciousAids(), []);
    assert.deepEqual(store.suspiciousAids(), []);
    const row = store.forAids([101])[0];
    assert.equal(row.risk, null);
    assert.equal(row.sources.automaticRisk, false);
  } finally {
    db.close();
  }
});

test("an Arena row cannot override a legacy mode risk", () => {
  const db = moderationDb();
  try {
    const store = createSqliteModerationStore(db, { attachExternal: false });
    store.saveRisk(risk(102, "regular", 25));
    store.saveRisk(risk(102, "arena", 100));

    const row = store.forAids([102])[0];
    assert.equal(row.risk?.mode, "regular");
    assert.equal(row.risk?.score, 25);
    assert.equal(row.sources.automaticRisk, true);
    assert.deepEqual(store.automaticSuspiciousAids(), [102]);
  } finally {
    db.close();
  }
});

test("generic risk evaluation rejects Arena before touching a store", async () => {
  const playerStore = {
    baseline() { throw new Error("baseline should not run"); },
    achievementBaseline() { throw new Error("achievement baseline should not run"); },
  };
  await assert.rejects(
    evaluateAndStoreRisk({
      aid: 103,
      mode: "arena",
      stats: { hoursPlayed: 100 },
      achievementIds: [],
      playerStore,
    }),
    (error) => error instanceof ArenaRiskUnsupportedError && error.message === "Arena risk is display-only",
  );
});

test("risk versions are isolated from untouched modes and cycles", () => {
  assert.equal(riskScoreVersion("regular", "persistent"), 2);
  assert.equal(riskScoreVersion("pve", "persistent"), 2);
  assert.equal(riskScoreVersion("seasonal", "cycle-a"), 2);
  assert.throws(() => riskScoreVersion("seasonal"), /cycleId/);
});

test("backfill guard executes the shared invalid-input predicate", () => {
  const valid = {
    pvpStatsKnown: true,
    hoursPlayed: 100,
    pmcRaids: 5,
    prestige: 0,
    pmcSurvivalRate: 50,
    pmcKdRatio: 8,
    pmcKillsPerRaid: 1,
    longestWinStreak: 0,
  };
  assert.equal(hasValidRiskInputs(valid), true);
  assert.equal(hasValidRiskInputs({ ...valid, longestWinStreak: Number.NaN }), false);
  assert.equal(hasValidRiskInputs({ ...valid, prestige: undefined }), false);
});

test("regular risk backfill uses the matched two-dimensional baseline", () => {
  const directory = mkdtempSync(join(tmpdir(), "tarkov-risk-backfill-"));
  const playersPath = join(directory, "players.db");
  const adminPath = join(directory, "admin.db");
  const bansPath = join(directory, "bans.db");
  const progressionPath = join(directory, "progression.db");
  const reportsPath = join(directory, "reports.db");
  const players = new DatabaseSync(playersPath);
  try {
    players.exec(`
      CREATE TABLE players (
        aid INTEGER PRIMARY KEY,
        nickname TEXT,
        hours REAL,
        pmc_raids INTEGER,
        total_raids INTEGER,
        kd_ratio REAL,
        pmc_kd_ratio REAL,
        pmc_kills_per_raid REAL,
        pmc_survival_rate REAL,
        longest_win_streak INTEGER,
        level INTEGER,
        prestige INTEGER,
        pvp_stats_known INTEGER,
        profile_updated_at INTEGER,
        achievements TEXT,
        stats_json TEXT
      );
      CREATE TABLE mode_players (mode TEXT, aid INTEGER, stats_json TEXT);
      CREATE TABLE excluded_players (aid INTEGER PRIMARY KEY, reason TEXT, created_at INTEGER);
    `);
    const insert = players.prepare(`INSERT INTO players
      (aid, nickname, hours, pmc_raids, total_raids, kd_ratio, pmc_kd_ratio,
       pmc_kills_per_raid, pmc_survival_rate, longest_win_streak, level, prestige,
       pvp_stats_known, profile_updated_at, achievements, stats_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, '{}')`);
    const now = Date.now();
    insert.run(1, "target", 100, 100, 100, 1, 1, 2, 50, 10, 20, 0, now);
    for (let aid = 2; aid <= 31; aid += 1) {
      insert.run(aid, `matched-${aid}`, 100, 100, 100, 1, 1, 2, 50, 10, 20, 0, now);
    }
    insert.run(32, "outlier", 500, 500, 500, 1, 100, 100, 100, 100, 20, 0, now);
  } finally {
    players.close();
  }

  try {
    const result = spawnSync(process.execPath, [
      "--experimental-strip-types",
      "--experimental-sqlite",
      "scripts/backfill-admin-risk.mjs",
    ], {
      cwd: resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        SQLITE_PATH: playersPath,
        ADMIN_ANALYTICS_SQLITE_PATH: adminPath,
        BANS_SQLITE_PATH: bansPath,
        PROGRESSION_SQLITE_PATH: progressionPath,
        REPORTS_SQLITE_PATH: reportsPath,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const admin = new DatabaseSync(adminPath);
    try {
      const saved = admin.prepare(`SELECT factors_json, score_version
        FROM risk_evaluations WHERE aid = 1 AND mode = 'regular' AND cycle_id = 'persistent'`).get();
      assert.equal(saved.score_version, 2);
      const factors = JSON.parse(saved.factors_json);
      assert.ok(factors.length > 0);
      assert.equal(factors.every((factor) => factor.z === null), true);
    } finally {
      admin.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("risk backfill only rescans legacy PvE mode rows", async () => {
  const source = await readFile("scripts/backfill-admin-risk.mjs", "utf8");
  const service = await readFile("lib/admin/risk-service.ts", "utf8");
  assert.match(service, /input\.mode === "regular"[\s\S]*store\.riskBaseline/);
  assert.match(service, /store\.riskBaseline2d\(input\.stats\.hoursPlayed, input\.stats\.pmcRaids, input\.aid, "all"\)/);
  assert.match(source, /FROM mode_players p\s+WHERE p\.mode = 'pve'/);
  assert.match(source, /scoreVersion: riskScoreVersion\(mode, cycleId\)/);
  assert.match(source, /const numberValue =/);
  assert.match(source, /statsFromRow\(row, mode\)/);
  assert.match(source, /mode === "regular" \|\| mode === "pve"/);
  assert.match(source, /const known = pve \? stored\.pvpStatsKnown/);
  assert.match(source, /regularRiskBaselineFor\(stats, Number\(row\.aid\)\)/);
  assert.match(source, /const hasUsableMetrics = baseline != null/);
  assert.match(source, /hasUsableMetrics && hasValidRiskInputs\(stats\)/);
  assert.match(source, /scoreCheater\(\{ \.\.\.stats, pmcRaids: 0 \}, null, null\)/);
  assert.doesNotMatch(source, /await scoreRow\(row, "arena"/);
});

test("PvE backfill uses the runtime invalid-input guard before achievements", async () => {
  const valid = {
    pvpStatsKnown: true,
    hoursPlayed: 5,
    pmcRaids: 5,
    pmcSurvivalRate: 50,
    pmcKdRatio: 1,
    pmcKillsPerRaid: 2,
    longestWinStreak: 3,
    prestige: 0,
  };
  assert.equal(hasValidRiskInputs(valid), true);
  for (const override of [
    { longestWinStreak: Number.NaN },
    { prestige: undefined },
    { pmcKdRatio: Number.POSITIVE_INFINITY },
    { pvpStatsKnown: false },
  ]) {
    assert.equal(hasValidRiskInputs({ ...valid, ...override }), false);
  }
  const source = await readFile("scripts/backfill-admin-risk.mjs", "utf8");
  assert.match(source, /const canScore =[\s\S]*hasValidRiskInputs\(stats\)/);
  assert.match(source, /if \(canScore && !baselines\.has\(baselineKey\)\)/);
  assert.match(source, /if \(canScore && !achievementBaselines\.has\(mode\)\)/);
});

test("executed PvE backfill stores zero for unknown combat metrics with achievements", () => {
  const directory = mkdtempSync(join(tmpdir(), "tarkov-pve-risk-backfill-"));
  const playersPath = join(directory, "players.db");
  const adminPath = join(directory, "admin.db");
  const bansPath = join(directory, "bans.db");
  const progressionPath = join(directory, "progression.db");
  const reportsPath = join(directory, "reports.db");
  for (const path of [bansPath, progressionPath, reportsPath]) new DatabaseSync(path).close();
  const players = new DatabaseSync(playersPath);
  players.exec(`CREATE TABLE mode_players (
    mode TEXT NOT NULL,
    aid INTEGER NOT NULL,
    nickname TEXT,
    hours REAL,
    pmc_raids INTEGER,
    total_raids INTEGER,
    pmc_survival_rate REAL,
    pmc_kd_ratio REAL,
    pmc_kills_per_raid REAL,
    longest_win_streak INTEGER,
    prestige INTEGER,
    achievements TEXT,
    pvp_stats_known INTEGER,
    profile_updated_at INTEGER,
    stats_json TEXT NOT NULL
  )`);
  players.exec("CREATE TABLE excluded_players (aid INTEGER PRIMARY KEY, reason TEXT NOT NULL, created_at INTEGER NOT NULL)");
  players.exec("CREATE TABLE players (aid INTEGER PRIMARY KEY)");
  const insert = players.prepare(`INSERT INTO mode_players
    (mode, aid, nickname, hours, pmc_raids, total_raids, pmc_survival_rate, pmc_kd_ratio,
     pmc_kills_per_raid, longest_win_streak, prestige, achievements, pvp_stats_known,
     profile_updated_at, stats_json)
    VALUES ('pve', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const validStats = (aid: number, owned: boolean) => JSON.stringify({
    pvpStatsKnown: true,
    hoursPlayed: 1000,
    pmcRaids: 1000,
    pmcSurvivalRate: 50,
    pmcKdRatio: 1,
    pmcKillsPerRaid: 2,
    longestWinStreak: 10,
    prestige: 0,
    nickname: `p${aid}`,
    achievementsCount: owned ? 1 : 0,
  });
  const targetStats = JSON.stringify({
    pvpStatsKnown: true,
    hoursPlayed: 5,
    pmcRaids: 5,
    pmcSurvivalRate: 0,
    pmcKdRatio: 0,
    pmcKillsPerRaid: 0,
    nickname: "invalid-target",
    achievementsCount: 1,
  });
  insert.run(1, "invalid-target", 5, 5, 5, 0, 0, 0, 0, 0, JSON.stringify(["rare"]), 1, 1, targetStats);
  for (let aid = 2; aid <= 11; aid += 1) {
    insert.run(aid, `owner${aid}`, 1000, 1000, 1000, 50, 1, 2, 10, 0, JSON.stringify(["rare"]), 1, 1, validStats(aid, true));
  }
  for (let aid = 12; aid <= 335; aid += 1) {
    insert.run(aid, `peer${aid}`, 1000, 1000, 1000, 50, 1, 2, 10, 0, "[]", 1, 1, validStats(aid, false));
  }
  players.close();

  const result = spawnSync(process.execPath, [
    "--experimental-strip-types",
    "--experimental-sqlite",
    "scripts/backfill-admin-risk.mjs",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SQLITE_PATH: playersPath,
      ADMIN_ANALYTICS_SQLITE_PATH: adminPath,
      BANS_SQLITE_PATH: bansPath,
      PROGRESSION_SQLITE_PATH: progressionPath,
      REPORTS_SQLITE_PATH: reportsPath,
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const admin = new DatabaseSync(adminPath);
  const row = admin.prepare("SELECT score, score_version FROM risk_evaluations WHERE aid = 1 AND mode = 'pve'").get();
  admin.close();
  assert.equal(Number(row.score), 0);
  assert.equal(Number(row.score_version), 2);
});
