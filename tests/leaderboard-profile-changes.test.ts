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

const { currentSqlitePlayerSchema, getStore } = await import("../lib/db.ts");
const { parseArenaProfileStats, parseProfileStats } = await import("../lib/tarkov-api.ts");
const { initializeProfileChangeJournal } = await import("../lib/profile-change-journal.ts");
const { leaderboardChangeWindow } = await import("../lib/leaderboard/source.ts");
const { createSqliteSeasonalStore, initializeSeasonalSchema, upsertSqliteSeasonCycle } =
  await import("../lib/seasonal/storage.ts");

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
      pvp_stats_known INTEGER, pvp_stats_version INTEGER, prestige INTEGER DEFAULT 0,
      fetched_at INTEGER NOT NULL
    );
    CREATE TABLE mode_players (
      mode TEXT NOT NULL, aid INTEGER NOT NULL, nickname TEXT, profile_updated_at INTEGER,
      pmc_killed_pmc INTEGER, pmc_deaths INTEGER, pmc_raids INTEGER, hours REAL,
      last_played_at INTEGER, pvp_stats_known INTEGER, pvp_stats_version INTEGER,
      prestige INTEGER DEFAULT 0, stats_json TEXT NOT NULL, fetched_at INTEGER NOT NULL,
      PRIMARY KEY(mode, aid)
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

// prestige is part of the materialized source fingerprint, so a prestige-only
// write has to reopen the incremental materializer's change window.
test("a prestige-only update reopens the regular and PvE change windows", async () => {
  const store = await getStore("regular");
  const pve = await getStore("pve");
  assert.ok(store && pve);
  await store.upsert(301, parseProfileStats(profile(301, 1_799_000_000_003)), []);
  await pve.upsert(302, parseProfileStats(profile(302, 1_799_000_000_004)), []);

  const db = new DatabaseSync(databasePath);
  try {
    const regular = leaderboardChangeWindow(db, "regular", 0);
    const pveWindow = leaderboardChangeWindow(db, "pve", 0);
    assert.ok(regular.cutoff > 0 && pveWindow.cutoff > 0);

    db.prepare("UPDATE players SET prestige=1, fetched_at=400 WHERE aid=301").run();
    db.prepare("UPDATE mode_players SET prestige=2, fetched_at=400 WHERE mode='pve' AND aid=302").run();

    assert.deepEqual(leaderboardChangeWindow(db, "regular", regular.cutoff).changes, [{ aid: 301, revision: 2 }]);
    assert.deepEqual(leaderboardChangeWindow(db, "pve", pveWindow.cutoff).changes, [{ aid: 302, revision: 2 }]);
  } finally {
    db.close();
  }
});

test("a prestige-only Seasonal snapshot replay reopens the seasonal change window", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeSeasonalSchema(db);
    upsertSqliteSeasonCycle(db, { mode: "seasonal", cycleId: "s1", startsAt: 1, endsAt: null,
      enabled: true, upstreamContract: "direct_profile" });
    const store = createSqliteSeasonalStore(db);
    const seasonal = (prestige) => ({
      mode: "seasonal", cycleId: "s1", aid: 7, nickname: "Seasonal", profileUpdatedAt: 300,
      lastAccessAt: 300, lifetimePvpHours: 100,
      counters: { experience: 100, pmcRaids: 20, scavRaids: 1, pmcSurvived: 5, pmcDeaths: 4,
        pmcKills: 30, killedPmc: 25 },
      seasonalStats: { totalRaids: 20, survivedRaids: 5, totalKills: 30, deaths: 4, runThrough: 2,
        survivalRate: 0.25, kdRatio: 7.5, pmcKdRatio: 7.5, killsPerRaid: 1.5, pmcSurvivalRate: 0.25,
        level: 5, prestige, longestWinStreak: 3, achievementsCount: 1 },
    });
    await store.upsertProfile(seasonal(0), 300);
    await store.captureSnapshot(seasonal(0), 400);
    const first = leaderboardChangeWindow(db, "pvp-season", 0, "s1");
    assert.deepEqual(first.changes, [{ aid: 7, revision: 1 }]);

    // The idempotent portrait backfill rewrites prestige on the existing
    // progression point without touching player_profiles.
    assert.equal((await store.captureSnapshot(seasonal(4), 500)).status, "duplicate");
    assert.equal(db.prepare("SELECT prestige FROM progression_snapshots WHERE mode='seasonal' AND aid=7")
      .get().prestige, 4);
    assert.deepEqual(leaderboardChangeWindow(db, "pvp-season", first.cutoff, "s1").changes,
      [{ aid: 7, revision: 2 }]);
  } finally {
    db.close();
  }
});

// The two UPDATE triggers as they were before prestige was added to the WHEN
// clause, kept verbatim so this test can rebuild a database the way a deployment
// that predates the prestige fix left it. `CREATE TRIGGER IF NOT EXISTS` never
// replaces an existing body, so an initializer that only re-runs the schema keeps
// these forever — and currentSqlitePlayerSchema() agrees, because it compares
// trigger names rather than bodies.
const PRE_PRESTIGE_UPDATE_TRIGGERS = `
DROP TRIGGER IF EXISTS trg_players_leaderboard_change_update;
CREATE TRIGGER trg_players_leaderboard_change_update
AFTER UPDATE ON players WHEN
  OLD.nickname IS NOT NEW.nickname OR OLD.profile_updated_at IS NOT NEW.profile_updated_at OR
  OLD.pmc_killed_pmc IS NOT NEW.pmc_killed_pmc OR OLD.pmc_deaths IS NOT NEW.pmc_deaths OR
  OLD.pmc_raids IS NOT NEW.pmc_raids OR OLD.hours IS NOT NEW.hours OR
  OLD.last_played_at IS NOT NEW.last_played_at OR OLD.pvp_stats_known IS NOT NEW.pvp_stats_known OR
  OLD.pvp_stats_version IS NOT NEW.pvp_stats_version
BEGIN
  INSERT INTO leaderboard_profile_changes (mode, aid, revision, changed_at)
  VALUES ('regular', NEW.aid, 1, NEW.fetched_at)
  ON CONFLICT(mode, aid) DO UPDATE SET
    change_id = excluded.change_id, revision = leaderboard_profile_changes.revision + 1,
    changed_at = excluded.changed_at;
END;
DROP TRIGGER IF EXISTS trg_mode_players_leaderboard_change_update;
CREATE TRIGGER trg_mode_players_leaderboard_change_update
AFTER UPDATE ON mode_players WHEN NEW.mode IN ('pve', 'arena') AND (
  OLD.nickname IS NOT NEW.nickname OR OLD.profile_updated_at IS NOT NEW.profile_updated_at OR
  (NEW.mode = 'pve' AND (
    OLD.pmc_killed_pmc IS NOT NEW.pmc_killed_pmc OR OLD.pmc_deaths IS NOT NEW.pmc_deaths OR
    OLD.pmc_raids IS NOT NEW.pmc_raids OR OLD.hours IS NOT NEW.hours OR
    OLD.last_played_at IS NOT NEW.last_played_at OR OLD.pvp_stats_known IS NOT NEW.pvp_stats_known OR
    OLD.pvp_stats_version IS NOT NEW.pvp_stats_version
  )) OR
  (NEW.mode = 'arena' AND (OLD.stats_json IS NOT NEW.stats_json OR OLD.fetched_at IS NOT NEW.fetched_at))
) BEGIN
  INSERT INTO leaderboard_profile_changes (mode, aid, revision, changed_at)
  VALUES (NEW.mode, NEW.aid, 1, NEW.fetched_at)
  ON CONFLICT(mode, aid) DO UPDATE SET
    change_id = excluded.change_id, revision = leaderboard_profile_changes.revision + 1,
    changed_at = excluded.changed_at;
END;`;

function triggerBody(db, name) {
  return db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name).sql;
}

test("re-initializing a database that predates the prestige clause reinstalls the update triggers", () => {
  const db = new DatabaseSync(databasePath);
  try {
    db.prepare("INSERT INTO players (aid, nickname, fetched_at) VALUES (900, 'Nine', 100)").run();
    db.prepare(`INSERT INTO mode_players (mode, aid, nickname, fetched_at, stats_json)
      VALUES ('pve', 901, 'NinePve', 100, '{}')`).run();
    const seeded = {
      regular: { ...marker(db, "regular", 900) },
      pve: { ...marker(db, "pve", 901) },
    };

    // Production shape: every object currentSqlitePlayerSchema() looks for is
    // present, but the two update triggers still carry the pre-prestige bodies.
    db.exec(PRE_PRESTIGE_UPDATE_TRIGGERS);
    assert.equal(currentSqlitePlayerSchema(db), true);
    assert.equal(triggerBody(db, "trg_players_leaderboard_change_update").includes("OLD.prestige"), false);

    assert.deepEqual(initializeProfileChangeJournal(db), { created: false });

    // The bodies are what changed, not the names, so re-running the schema alone
    // leaves the old WHEN clause in place on a database that is already current.
    assert.equal(triggerBody(db, "trg_players_leaderboard_change_update").includes("OLD.prestige"), true);
    assert.equal(triggerBody(db, "trg_mode_players_leaderboard_change_update").includes("OLD.prestige"), true);

    // The journal rows and their revisions survived the reinstall: the trigger is
    // a write path, the cursor lives in the table.
    assert.deepEqual(
      { ...marker(db, "regular", 900) },
      seeded.regular,
    );
    assert.deepEqual({ ...marker(db, "pve", 901) }, seeded.pve);

    db.prepare("UPDATE players SET prestige = 7 WHERE aid = 900").run();
    db.prepare("UPDATE mode_players SET prestige = 3 WHERE mode = 'pve' AND aid = 901").run();
    assert.equal(marker(db, "regular", 900).revision, seeded.regular.revision + 1);
    assert.equal(marker(db, "pve", 901).revision, seeded.pve.revision + 1);

    // Once the stored body matches, a second init must not churn the trigger.
    assert.deepEqual(initializeProfileChangeJournal(db), { created: false });
    assert.equal(triggerBody(db, "trg_players_leaderboard_change_update").includes("OLD.prestige"), true);
  } finally {
    db.close();
  }
});
