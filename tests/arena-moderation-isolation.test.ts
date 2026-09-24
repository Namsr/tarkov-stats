/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- node:sqlite types are not present in the project's Node 20 type package.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
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
const { ArenaRiskUnsupportedError, evaluateAndStoreRisk } = await import("../lib/admin/risk-service.ts");
const { pveRiskNeedsZero } = await import("../lib/admin/risk-version.ts");

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

test("risk backfill only rescans legacy PvE mode rows", async () => {
  const source = await readFile("scripts/backfill-admin-risk.mjs", "utf8");
  assert.match(source, /FROM mode_players p\s+WHERE p\.mode = 'pve'/);
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
  assert.equal(pveRiskNeedsZero(valid), false);
  for (const override of [
    { longestWinStreak: Number.NaN },
    { prestige: undefined },
    { pmcKdRatio: Number.POSITIVE_INFINITY },
    { pvpStatsKnown: false },
    { pvpStatsKnown: undefined },
  ]) {
    assert.equal(pveRiskNeedsZero({ ...valid, ...override }), true);
  }
  const source = await readFile("scripts/backfill-admin-risk.mjs", "utf8");
  assert.match(source, /pveRiskNeedsZero\(stats\)/);
  assert.match(source, /pvpStatsKnown: pve/);
  assert.match(source, /\? stored\.pvpStatsKnown === true/);
  assert.match(source, /if \(!zeroRisk && !achievementBaselines\.has\(baselineMode\)\)/);
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
