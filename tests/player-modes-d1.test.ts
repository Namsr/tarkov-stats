/* eslint-disable @typescript-eslint/ban-ts-comment */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// @ts-ignore -- Node 24 exposes node:sqlite at runtime; project types target Node 20.
import { DatabaseSync } from "node:sqlite";

const migration = readFileSync("scripts/player-modes-d1.sql", "utf8");
const profileVersionMigration = readFileSync("scripts/profile-version-d1.sql", "utf8");

test("PVE and Arena rows remain isolated for the same account", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(migration);
  const insert = db.prepare(`INSERT INTO mode_players
    (mode, aid, nickname, fetched_at, stats_json, achievements)
    VALUES (?, ?, ?, ?, ?, ?)`);

  insert.run("pve", 42, "PVE profile", 1, '{"nickname":"PVE profile"}', "[]");
  insert.run("arena", 42, "Arena profile", 1, '{"nickname":"Arena profile"}', "[]");

  assert.equal(
    (db.prepare("SELECT nickname FROM pve_players WHERE aid = 42").get() as { nickname: string }).nickname,
    "PVE profile",
  );
  assert.equal(
    (db.prepare("SELECT nickname FROM arena_players WHERE aid = 42").get() as { nickname: string }).nickname,
    "Arena profile",
  );
  assert.throws(() => insert.run("regular", 42, "Bad", 1, "{}", "[]"));
});

test("profile-version migration preserves explicit positive PvP data and leaves legacy zeroes unknown", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE players (
    aid INTEGER PRIMARY KEY,
    killed_pmc INTEGER DEFAULT 0,
    pmc_kd_ratio REAL DEFAULT 0
  )`);
  db.exec(migration);
  db.exec("INSERT INTO players (aid, killed_pmc, pmc_kd_ratio) VALUES (1, 0, 0), (2, 3, 0)");
  db.exec(`INSERT INTO mode_players
    (mode, aid, nickname, killed_pmc, fetched_at, stats_json)
    VALUES ('pve', 1, 'zero', 0, 1, '{}'), ('arena', 2, 'positive', 3, 1, '{}')`);

  db.exec(profileVersionMigration);

  assert.deepEqual(
    db.prepare("SELECT aid, profile_updated_at, pvp_stats_known FROM players ORDER BY aid")
      .all().map((row) => ({ ...row })),
    [
      { aid: 1, profile_updated_at: 0, pvp_stats_known: 0 },
      { aid: 2, profile_updated_at: 0, pvp_stats_known: 1 },
    ],
  );
  assert.deepEqual(
    db.prepare("SELECT aid, profile_updated_at, pvp_stats_known FROM mode_players ORDER BY aid")
      .all().map((row) => ({ ...row })),
    [
      { aid: 1, profile_updated_at: 0, pvp_stats_known: 0 },
      { aid: 2, profile_updated_at: 0, pvp_stats_known: 1 },
    ],
  );
});
