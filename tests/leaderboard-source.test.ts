import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error node:sqlite types require a newer @types/node than the app uses.
const { DatabaseSync } = await import("node:sqlite");
// @ts-expect-error Node's direct TypeScript runner needs the explicit extension.
const { arenaTabCounts, leaderboardChangeWindow, leaderboardSourceRows } = await import("../lib/leaderboard/source.ts");
// @ts-expect-error Node's direct TypeScript runner needs the explicit extension.
const { parseLeaderboardRequest } = await import("../lib/leaderboard/runtime.ts");
import type { LeaderboardScopeConfig } from "../lib/leaderboard/config";

const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE excluded_players(aid INTEGER PRIMARY KEY);
  CREATE TABLE players(aid INTEGER PRIMARY KEY,nickname TEXT,profile_updated_at INTEGER,pmc_killed_pmc INTEGER,
    pmc_deaths INTEGER,pmc_raids INTEGER,hours REAL,last_played_at INTEGER,pvp_stats_known INTEGER,pvp_stats_version INTEGER);
  CREATE TABLE mode_players(mode TEXT,aid INTEGER,nickname TEXT,PRIMARY KEY(mode,aid));
  CREATE TABLE arena_mode_stats(aid INTEGER,arena_mode TEXT,hours REAL,games_count INTEGER,kills INTEGER,deaths INTEGER,
    kills_per_match REAL,upstream_version INTEGER,parser_version INTEGER,raw_json TEXT,fetched_at INTEGER,best_arp INTEGER,
    PRIMARY KEY(aid,arena_mode));
  INSERT INTO players VALUES (1,'Exact',200,0,0,0,10,150,1,1),(2,'Legacy',200,50,2,20,10,150,1,0);
  INSERT INTO mode_players VALUES ('arena',10,'Arena');
  INSERT INTO arena_mode_stats VALUES (10,'overall',40,NULL,NULL,NULL,NULL,300,1,
    '{"sourceCounters":{"Counters":{"Items":[{"Key":["BestArp"],"Value":1900}]}}}',250,NULL);
  INSERT INTO arena_mode_stats VALUES (10,'blastGang',40,0,0,0,NULL,300,2,'{}',250,NULL);
  INSERT INTO arena_mode_stats VALUES (10,'lastHero',40,5,12,3,2.4,300,2,'{}',250,NULL);
  CREATE TABLE player_profiles(mode TEXT,cycle_id TEXT,aid INTEGER,nickname TEXT,profile_updated_at INTEGER,
    leaderboard_activity_at INTEGER,lifetime_pvp_hours REAL,pmc_raids INTEGER,pmc_deaths INTEGER,
    pmc_killed_pmc INTEGER,pvp_stats_version INTEGER,pvp_stats_parser_version INTEGER,
    confirmed_banned INTEGER,PRIMARY KEY(mode,cycle_id,aid));
  CREATE TABLE leaderboard_seasonal_profile_changes(change_id INTEGER PRIMARY KEY AUTOINCREMENT,
    cycle_id TEXT,aid INTEGER,revision INTEGER,changed_at INTEGER,UNIQUE(cycle_id,aid));
  INSERT INTO player_profiles VALUES ('seasonal','s1',20,'Season',300,250,60,20,4,16,1,1,0);
  INSERT INTO player_profiles VALUES ('seasonal','s1',21,'Incomplete',300,250,60,20,4,NULL,0,1,0);
  INSERT INTO player_profiles VALUES ('seasonal','s1',22,'Banned',300,250,60,20,4,16,1,1,1);
  INSERT INTO leaderboard_seasonal_profile_changes(cycle_id,aid,revision,changed_at) VALUES ('s1',20,2,300);
`);

const regular: LeaderboardScopeConfig = { scope: "regular", mode: "regular", arenaMode: null, cycleId: null, primaryMetric: "performance",
  minimumSample: 6, activityCutoffMs: 100, arpSeasonId: null, arpSourceConfirmed: false };
const blast: LeaderboardScopeConfig = { scope: "arena:blastGang:initial", mode: "arena", arenaMode: "blastGang", cycleId: null, primaryMetric: "arp",
  minimumSample: 6, activityCutoffMs: 100, arpSeasonId: "initial", arpSourceConfirmed: true };
const seasonal: LeaderboardScopeConfig = { scope: "seasonal:s1", mode: "pvp-season", arenaMode: null, cycleId: "s1",
  primaryMetric: "performance", minimumSample: 6, activityCutoffMs: 200, arpSeasonId: null, arpSourceConfirmed: false };

test("standard source requires exact tuple version and preserves a known zero", () => {
  const exact = [...leaderboardSourceRows(db, regular)];
  assert.equal(exact[0].kills, 0);
  assert.equal(exact[0].deaths, 0);
  assert.equal(exact[1].kills, null);
  assert.equal(exact[1].matches, null);
});

test("Arena uses successful fetched_at activity, overall hours, and shared BestArp", () => {
  const row = [...leaderboardSourceRows(db, blast, 10)][0];
  assert.equal(row.activityAt, 250);
  assert.equal(row.activitySource, "profile_check");
  assert.equal(row.hours, 40);
  assert.equal(row.bestArp, 1900);
  assert.deepEqual(arenaTabCounts(db), [
    { mode: "blastGang", knownMatchProfiles: 1 },
    { mode: "lastHero", knownMatchProfiles: 1 },
    { mode: "checkpoint", knownMatchProfiles: 0 },
    { mode: "shootOutDuo", knownMatchProfiles: 0 },
    { mode: "teamFight", knownMatchProfiles: 0 },
  ]);
});

test("PvP season uses only its cycle-certified exact tuple and skill activity", () => {
  const rows = [...leaderboardSourceRows(db, seasonal)];
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    aid: 20, nickname: "Season", sourceUpdatedAt: 300, sourceRevision: 2, parserVersion: 1,
    activityAt: 250, activitySource: "skill", matches: 20, kills: 16, deaths: 4, hours: 60,
    currentArp: null, bestArp: null,
  });
  assert.equal(rows[1].kills, null);
  assert.equal(rows.some((row) => row.aid === 22), false);
});

test("change windows pin a monotonic cutoff and leave concurrent changes for the next run", () => {
  assert.deepEqual(leaderboardChangeWindow(db, "regular", 0), { cutoff: 0, changes: [] });
  db.exec(`CREATE TABLE leaderboard_profile_changes(change_id INTEGER PRIMARY KEY AUTOINCREMENT,
    mode TEXT,aid INTEGER,revision INTEGER,changed_at INTEGER,UNIQUE(mode,aid));
    INSERT INTO leaderboard_profile_changes(mode,aid,revision,changed_at) VALUES ('regular',1,1,1),('pve',2,1,1)`);
  const first = leaderboardChangeWindow(db, "regular", 0);
  db.exec("INSERT INTO leaderboard_profile_changes(mode,aid,revision,changed_at) VALUES ('regular',3,1,1)");
  assert.deepEqual(first.changes, [{ aid: 1, revision: 1 }]);
  assert.equal(first.cutoff, 2);
  assert.deepEqual(leaderboardChangeWindow(db, "regular", first.cutoff).changes, [{ aid: 3, revision: 1 }]);
  assert.equal([...leaderboardSourceRows(db, regular, 1)][0].sourceRevision, 1);
  assert.deepEqual(leaderboardChangeWindow(db, "pvp-season", 0, "s1"), {
    cutoff: 1, changes: [{ aid: 20, revision: 2 }],
  });
});

test("PvP season requests resolve the active cycle and reject aliases or stale cycles", () => {
  const names = ["SEASONAL_ENABLED", "SEASONAL_CYCLE_ID", "SEASONAL_STARTS_AT", "SEASONAL_UPSTREAM_CONTRACT"] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, { SEASONAL_ENABLED: "true", SEASONAL_CYCLE_ID: "s1",
    SEASONAL_STARTS_AT: "100", SEASONAL_UPSTREAM_CONTRACT: "direct_profile" });
  try {
    assert.equal(parseLeaderboardRequest(new URLSearchParams("mode=pvp-season")).config.cycleId, "s1");
    assert.equal(parseLeaderboardRequest(new URLSearchParams("mode=pvp-season&cycle=s1")).config.scope, "seasonal:s1");
    assert.throws(() => parseLeaderboardRequest(new URLSearchParams("mode=pvp-season&cycle=old")));
    assert.throws(() => parseLeaderboardRequest(new URLSearchParams("mode=seasonal")));
  } finally {
    for (const name of names) {
      if (previous[name] == null) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test.after(() => db.close());
