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

const directory = mkdtempSync(join(tmpdir(), "tarkov-leaderboard-persistence-"));
const databasePath = join(directory, "players.db");
process.env.SQLITE_PATH = databasePath;
process.env.BANS_SQLITE_PATH = join(directory, "bans.db");

const { getStore } = await import("../lib/db.ts");
const { needsPvpStatsParserRefresh, parseArenaProfileStats, parseProfileStats } = await import("../lib/tarkov-api.ts");
const { ARENA_PARSER_VERSION } = await import("../lib/arena/storage.ts");
const { backfillLeaderboardExactFields } = await import("../scripts/backfill-leaderboard-exact-fields.mjs");

function regularProfile(aid, updated, { pmcKilledPmc, scavKilledPmc = 0, lastAccess } = {}) {
  const pmcItems = [
    { Key: ["Sessions", "Pmc"], Value: 10 },
    { Key: ["Deaths"], Value: 2 },
    ...(pmcKilledPmc === undefined ? [] : [{ Key: ["KilledPmc"], Value: pmcKilledPmc }]),
  ];
  return {
    aid,
    updated,
    info: { nickname: `Player${aid}`, side: "Usec", experience: 0 },
    pmcStats: { eft: { totalInGameTime: 3_600, overAllCounters: { Items: pmcItems } } },
    scavStats: { eft: { totalInGameTime: 3_600, overAllCounters: { Items: [
      { Key: ["Sessions", "Scav"], Value: 3 },
      { Key: ["KilledPmc"], Value: scavKilledPmc },
    ] } } },
    skills: { Common: lastAccess === undefined ? [] : [
      { Id: "Strength", Progress: 1, PointsEarnedDuringSession: 0, LastAccess: lastAccess },
    ] },
  };
}

const arenaModes = [
  "UnrankedTeamFight",
  "UnrankedLastHero",
  "UnrankedCheckPoint",
  "UnrankedBlastGang",
  "UnrankedShootOutDuo",
];

function arenaProfile(aid, updated, bestArp) {
  const group = { Counters: { GamesCount: 10, Kills: 20, Deaths: 5 } };
  return {
    aid,
    updated,
    info: { nickname: `Arena${aid}`, side: "Usec", experience: 0 },
    stat: {
      totalInGameTime: 3_600,
      arenaOverAllCounters: {
        UnrankedOverall: { Counters: {
          GamesCount: 50,
          ...(bestArp === undefined ? {} : { BestArp: bestArp }),
        } },
        ...Object.fromEntries(arenaModes.map((mode) => [mode, group])),
      },
    },
  };
}

test("regular and PvE rows persist exact PMC kills and skill activity without mixing Scav kills", async () => {
  const regular = await getStore("regular");
  const pve = await getStore("pve");
  assert.ok(regular && pve);
  const updated = 1_800_000_000_000;
  await regular.upsert(101, parseProfileStats(regularProfile(101, updated, {
    pmcKilledPmc: 0,
    scavKilledPmc: 9,
    lastAccess: 1_799_000_000,
  })), []);
  await pve.upsert(102, parseProfileStats(regularProfile(102, updated, {
    pmcKilledPmc: 7,
    scavKilledPmc: 11,
    lastAccess: 1_799_000_001,
  })), []);

  const db = new DatabaseSync(databasePath);
  try {
    assert.deepEqual({ ...db.prepare(`SELECT pmc_killed_pmc, killed_pmc, last_played_at, pvp_stats_known, pvp_stats_version
      FROM players WHERE aid = 101`).get() }, {
      pmc_killed_pmc: 0,
      killed_pmc: 9,
      last_played_at: 1_799_000_000_000,
      pvp_stats_known: 1,
      pvp_stats_version: 1,
    });
    assert.deepEqual({ ...db.prepare(`SELECT pmc_killed_pmc, killed_pmc, last_played_at
      FROM mode_players WHERE mode = 'pve' AND aid = 102`).get() }, {
      pmc_killed_pmc: 7,
      killed_pmc: 18,
      last_played_at: 1_799_000_001_000,
    });
  } finally {
    db.close();
  }
});

test("missing exact data stays null, same-version refresh fills it, and an older snapshot cannot replace it", async () => {
  const store = await getStore("regular");
  assert.ok(store);
  const updated = 1_800_000_010_000;
  await store.upsert(103, parseProfileStats(regularProfile(103, updated)), []);
  await store.upsert(103, parseProfileStats(regularProfile(103, updated, {
    pmcKilledPmc: 0,
    lastAccess: 1_799_000_002,
  })), []);
  await store.upsert(103, parseProfileStats(regularProfile(103, updated - 1, {
    pmcKilledPmc: 99,
    lastAccess: 1_799_000_003,
  })), []);

  const db = new DatabaseSync(databasePath);
  try {
    assert.deepEqual({ ...db.prepare(`SELECT pmc_killed_pmc, last_played_at, profile_updated_at
      FROM players WHERE aid = 103`).get() }, {
      pmc_killed_pmc: 0,
      last_played_at: 1_799_000_002_000,
      profile_updated_at: updated,
    });
  } finally {
    db.close();
  }
});

test("a partial exact tuple preserves legacy known status but remains ranking version zero", async () => {
  const store = await getStore("regular");
  assert.ok(store);
  const parsed = parseProfileStats(regularProfile(104, 1_800_000_011_000, { pmcKilledPmc: 0 }));
  parsed.pmcRaids = 0;
  parsed.pvpStatsKnown = true;
  parsed.pvpStatsVersion = 0;
  await store.upsert(104, parsed, []);

  const db = new DatabaseSync(databasePath);
  try {
    assert.deepEqual({ ...db.prepare(`SELECT pmc_killed_pmc, pvp_stats_known, pvp_stats_version
      FROM players WHERE aid = 104`).get() }, {
      pmc_killed_pmc: 0,
      pvp_stats_known: 1,
      pvp_stats_version: 0,
    });
  } finally {
    db.close();
  }
});

test("PvE same-timestamp parser upgrade persists missing metrics without another refresh", async () => {
  const store = await getStore("pve");
  assert.ok(store);
  const updated = 1_800_000_012_000;
  const freshMissing = parseProfileStats(regularProfile(105, updated));
  const legacy = { ...freshMissing };
  delete legacy.pvpStatsParserVersion;
  await store.upsert(105, legacy, []);
  await store.upsert(105, freshMissing, []);

  const stored = await store.stored(105);
  assert.equal(stored?.stats.pvpStatsVersion, 0);
  assert.equal(stored?.stats.pmcKilledPmc, null);
  assert.equal(needsPvpStatsParserRefresh(stored?.stats), false);
});

test("Arena stores nullable BestArp in current and history rows and parser refreshes the same upstream version", async () => {
  const store = await getStore("arena");
  assert.ok(store);
  const updated = 1_800_000_020_000;
  const oldParser = parseArenaProfileStats(arenaProfile(201, updated));
  oldParser.arenaProfile.parserVersion = 1;
  await store.upsert(201, oldParser, []);
  await store.upsert(201, parseArenaProfileStats(arenaProfile(201, updated, 0)), []);
  await store.upsert(202, parseArenaProfileStats(arenaProfile(202, updated + 1, 1750)), []);

  const db = new DatabaseSync(databasePath);
  try {
    assert.equal(ARENA_PARSER_VERSION, 2);
    assert.equal(db.prepare(`SELECT best_arp FROM arena_mode_stats
      WHERE aid = 201 AND arena_mode = 'overall'`).get().best_arp, 0);
    assert.equal(db.prepare(`SELECT best_arp FROM arena_mode_stats_history
      WHERE aid = 201 AND arena_mode = 'overall' AND parser_version = 2`).get().best_arp, 0);
    assert.equal(db.prepare(`SELECT best_arp FROM arena_mode_stats
      WHERE aid = 202 AND arena_mode = 'overall'`).get().best_arp, 1750);
    assert.equal(db.prepare(`SELECT best_arp FROM arena_mode_stats
      WHERE aid = 202 AND arena_mode = 'teamFight'`).get().best_arp, null);
  } finally {
    db.close();
  }
});

test("backfill accepts only exact version-matched JSON and preserves explicit zero", async () => {
  const pve = await getStore("pve");
  const arena = await getStore("arena");
  assert.ok(pve && arena);
  const db = new DatabaseSync(databasePath);
  try {
    const exact = parseProfileStats(regularProfile(301, 1_800_000_030_000, {
      pmcKilledPmc: 0,
      lastAccess: 1_799_000_004,
    }));
    db.prepare(`INSERT INTO mode_players
      (mode, aid, nickname, profile_updated_at, fetched_at, stats_json, achievements)
      VALUES ('pve', ?, 'Exact', ?, 1, ?, '[]')`).run(301, exact.profileUpdatedAt, JSON.stringify(exact));
    db.prepare(`INSERT INTO mode_players
      (mode, aid, nickname, profile_updated_at, fetched_at, stats_json, achievements)
      VALUES ('pve', ?, 'Mismatch', ?, 1, ?, '[]')`).run(302, exact.profileUpdatedAt + 1, JSON.stringify(exact));
    db.prepare(`INSERT INTO mode_players
      (mode, aid, nickname, profile_updated_at, fetched_at, stats_json, achievements)
      VALUES ('pve', ?, 'Malformed', ?, 1, ?, '[]')`).run(304, exact.profileUpdatedAt, JSON.stringify({
        ...exact,
        pmcRaids: "bad",
      }));

    await arena.upsert(303, parseArenaProfileStats(arenaProfile(303, 1_800_000_030_003, 0)), []);
    db.exec("UPDATE arena_mode_stats SET best_arp = NULL WHERE aid = 303 AND arena_mode = 'overall'");
    db.exec("UPDATE arena_mode_stats_history SET best_arp = NULL WHERE aid = 303 AND arena_mode = 'overall'");

    const summary = backfillLeaderboardExactFields(db);
    assert.equal(summary.pveUpdated, 2);
    assert.equal(summary.arenaUpdated, 2);
    assert.deepEqual({ ...db.prepare(`SELECT pmc_killed_pmc, last_played_at
      FROM mode_players WHERE aid = 301`).get() }, {
      pmc_killed_pmc: 0,
      last_played_at: 1_799_000_004_000,
    });
    assert.equal(db.prepare("SELECT pmc_killed_pmc FROM mode_players WHERE aid = 302").get().pmc_killed_pmc, null);
    assert.deepEqual({ ...db.prepare(`SELECT pmc_killed_pmc, pvp_stats_version
      FROM mode_players WHERE aid = 304`).get() }, {
      pmc_killed_pmc: null,
      pvp_stats_version: 0,
    });
    assert.equal(db.prepare(`SELECT best_arp FROM arena_mode_stats
      WHERE aid = 303 AND arena_mode = 'overall'`).get().best_arp, 0);
  } finally {
    db.close();
  }
});
