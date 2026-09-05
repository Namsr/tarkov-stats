/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript runner requires explicit .ts imports.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

const directory = mkdtempSync(join(tmpdir(), "tarkov-leaderboard-changes-"));
const databasePath = join(directory, "players.db");
process.env.SQLITE_PATH = databasePath;
process.env.BANS_SQLITE_PATH = join(directory, "bans.db");

const { getStore } = await import("../lib/db.ts");
const { parseArenaProfileStats, parseProfileStats } = await import("../lib/tarkov-api.ts");
const { initializeProfileChangeJournal } = await import("../lib/profile-change-journal.ts");

function profile(aid, updated, killedPmc) {
  return {
    aid,
    updated,
    info: { nickname: `P${aid}`, side: "Usec", experience: 0 },
    pmcStats: { eft: { totalInGameTime: 3_600, overAllCounters: { Items: [
      { Key: ["Sessions", "Pmc"], Value: 10 },
      { Key: ["Deaths"], Value: 2 },
      ...(killedPmc === undefined ? [] : [{ Key: ["KilledPmc"], Value: killedPmc }]),
    ] } } },
    scavStats: { eft: { totalInGameTime: 0, overAllCounters: { Items: [] } } },
    skills: { Common: [{ Id: "Strength", Progress: 1, LastAccess: 1_799_000_000 }] },
  };
}

function arenaProfile(aid, updated) {
  const group = { Counters: { GamesCount: 10, Kills: 20, Deaths: 5 } };
  return {
    aid,
    updated,
    info: { nickname: `A${aid}`, side: "Usec", experience: 0 },
    stat: { totalInGameTime: 3_600, arenaOverAllCounters: {
      UnrankedOverall: { Counters: { GamesCount: 50, BestArp: 1_500 } },
      UnrankedTeamFight: group,
      UnrankedLastHero: group,
      UnrankedCheckPoint: group,
      UnrankedBlastGang: group,
      UnrankedShootOutDuo: group,
    } },
  };
}

function marker(db, mode, aid) {
  return db.prepare(`SELECT change_id, revision, changed_at FROM leaderboard_profile_changes
    WHERE mode = ? AND aid = ?`).get(mode, aid);
}

test("standalone startup installs the journal before the first profile capture", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE players (
      aid INTEGER PRIMARY KEY, nickname TEXT, profile_updated_at INTEGER, pmc_killed_pmc INTEGER,
      pmc_deaths INTEGER, pmc_raids INTEGER, hours REAL, last_played_at INTEGER,
      pvp_stats_known INTEGER, pvp_stats_version INTEGER, fetched_at INTEGER NOT NULL
    );
    CREATE TABLE mode_players (
      mode TEXT NOT NULL, aid INTEGER NOT NULL, nickname TEXT, profile_updated_at INTEGER,
      pmc_killed_pmc INTEGER, pmc_deaths INTEGER, pmc_raids INTEGER, hours REAL,
      last_played_at INTEGER, pvp_stats_known INTEGER, pvp_stats_version INTEGER,
      stats_json TEXT NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY(mode, aid)
    )`);
    assert.deepEqual(initializeProfileChangeJournal(db), { created: true });
    assert.deepEqual(initializeProfileChangeJournal(db), { created: false });
    db.prepare(`INSERT INTO players (aid, nickname, fetched_at) VALUES (1, 'One', 100)`).run();
    assert.deepEqual({ ...marker(db, "regular", 1) }, { change_id: 1, revision: 1, changed_at: 100 });
  } finally {
    db.close();
  }
});

test("profile changes use monotonic IDs, survive same-ms promotion, and mark deletions", async () => {
  const store = await getStore("regular");
  assert.ok(store);
  const db = new DatabaseSync(databasePath);
  const originalNow = Date.now;
  Date.now = () => 1_800_000_000_000;
  try {
    const updated = 1_799_000_000_000;
    await store.upsert(101, parseProfileStats(profile(101, updated)), []);
    const inserted = marker(db, "regular", 101);
    assert.deepEqual({ revision: inserted.revision, changedAt: inserted.changed_at }, {
      revision: 1,
      changedAt: 1_800_000_000_000,
    });

    await store.upsert(101, parseProfileStats(profile(101, updated)), []);
    assert.deepEqual({ ...marker(db, "regular", 101) }, { ...inserted });

    await store.upsert(101, parseProfileStats(profile(101, updated, 0)), []);
    const promoted = marker(db, "regular", 101);
    assert.equal(promoted.revision, 2);
    assert.ok(promoted.change_id > inserted.change_id);
    assert.equal(promoted.changed_at, inserted.changed_at);

    await store.upsert(101, parseProfileStats(profile(101, updated, 3)), []);
    const sameMillisecond = marker(db, "regular", 101);
    assert.equal(sameMillisecond.revision, 3);
    assert.ok(sameMillisecond.change_id > promoted.change_id);
    assert.equal(sameMillisecond.changed_at, promoted.changed_at);

    db.prepare("DELETE FROM players WHERE aid = ?").run(101);
    const deleted = marker(db, "regular", 101);
    assert.equal(deleted.revision, 4);
    assert.ok(deleted.change_id > sameMillisecond.change_id);
  } finally {
    Date.now = originalNow;
    db.close();
  }
});

test("PvE and Arena bump once per persisted profile and rollback markers with failed Arena saves", async () => {
  const pve = await getStore("pve");
  const arena = await getStore("arena");
  assert.ok(pve && arena);
  await pve.upsert(201, parseProfileStats(profile(201, 1_799_000_000_001, 0)), []);
  await arena.upsert(202, parseArenaProfileStats(arenaProfile(202, 1_799_000_000_002)), []);

  const db = new DatabaseSync(databasePath);
  try {
    assert.equal(marker(db, "pve", 201).revision, 1);
    assert.equal(marker(db, "arena", 202).revision, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM arena_mode_stats WHERE aid = 202").get().n, 6);

    db.exec(`CREATE TRIGGER fail_arena_profile BEFORE INSERT ON arena_mode_stats
      WHEN NEW.aid = 203 BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
    await assert.rejects(
      arena.upsert(203, parseArenaProfileStats(arenaProfile(203, 1_799_000_000_003)), []),
      /fixture failure/,
    );
    assert.equal(marker(db, "arena", 203), undefined);
    assert.equal(db.prepare("SELECT 1 FROM mode_players WHERE mode = 'arena' AND aid = 203").get(), undefined);
  } finally {
    db.close();
  }
});
