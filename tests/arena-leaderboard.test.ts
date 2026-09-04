/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- The direct Node runner uses the same path hook as Arena route tests.
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

const directory = mkdtempSync(join(tmpdir(), "tarkov-arena-leaderboard-"));
process.env.SQLITE_PATH = join(directory, "players.db");
process.env.BANS_SQLITE_PATH = join(directory, "bans.db");

const { getStore } = await import("../lib/db.ts");
const { parseArenaProfileStats } = await import("../lib/tarkov-api.ts");
const { getArenaLeaderboard } = await import("../lib/arena/service.ts");

const modeNames = [
  "UnrankedTeamFight",
  "UnrankedLastHero",
  "UnrankedCheckPoint",
  "UnrankedBlastGang",
  "UnrankedShootOutDuo",
];

function group(games, kills, deaths) {
  return { Counters: {
    GamesCount: games, ArenaWins: Math.floor(games / 2), ArenaLoses: Math.floor(games / 3),
    Kills: kills, Deaths: deaths, Assists: 2, Headshots: Math.floor(kills / 4),
    DamageDealt: kills * 400, RoundMvpCount: 1, MatchMvpCount: 1,
    KillsWithoutDeaths: 2, MaxKillsWithoutDeaths: 7, WinStreak: 2,
    LongestWinStreak: 5, LoseStreak: 1, LongestLoseStreak: 3,
  } };
}

function profile(aid, { games = 20, kills = 30, deaths = 20, bestArp = 1500 } = {}) {
  const modes = Object.fromEntries(modeNames.map((name) => [name, group(games, kills, deaths)]));
  return {
    aid,
    updated: 1_800_000_000_000 + aid,
    info: { nickname: `ArenaLb${aid}`, side: "Usec", experience: 0 },
    stat: {
      totalInGameTime: 100 * 3_600,
      arenaOverAllCounters: {
        UnrankedOverall: { Counters: { ...group(games * 5, kills * 5, deaths * 5).Counters, BestArp: bestArp } },
        ...modes,
      },
    },
  };
}

async function save(source) {
  const store = await getStore("arena");
  assert.ok(store);
  await store.upsert(source.aid, parseArenaProfileStats(source), []);
}

async function resetArenaData() {
  // Touch the store first so a fresh temp database has its schema.
  const store = await getStore("arena");
  assert.ok(store);
  const db = new DatabaseSync(process.env.SQLITE_PATH);
  try {
    db.exec("DELETE FROM arena_risk_evaluations; DELETE FROM arena_mode_stats_history; DELETE FROM arena_mode_stats; DELETE FROM mode_players WHERE mode = 'arena'; DELETE FROM excluded_players");
  } finally {
    db.close();
  }
}

test("Arena parser carries BestArp into the normalized overall snapshot", () => {
  const parsed = parseArenaProfileStats(profile(701, { bestArp: 1750 }));
  assert.equal(parsed.arenaProfile.overall.bestArp, 1750);
  assert.equal(parsed.arena.bestArp, 1750);
  const unrated = profile(702, {});
  delete unrated.stat.arenaOverAllCounters.UnrankedOverall.Counters.BestArp;
  const missing = parseArenaProfileStats(unrated);
  assert.equal(missing.arenaProfile.overall.bestArp, null);
  const empty = parseArenaProfileStats({ aid: 703, info: { nickname: "x", side: "Usec", experience: 0 } });
  assert.equal(empty.arenaProfile.overall.bestArp, null);
});

test("Arena leaderboard orders by BestArp and honors the limit", async () => {
  resetArenaData();
  await save(profile(711, { bestArp: 1200 }));
  await save(profile(712, { bestArp: 2500 }));
  await save(profile(713, { bestArp: 1800 }));
  const board = await getArenaLeaderboard(10, 0);
  assert.ok(board);
  assert.equal(board.total, 3);
  assert.deepEqual(board.entries.map((entry) => entry.aid), [712, 713, 711]);
  assert.deepEqual(board.entries.map((entry) => entry.rank), [1, 2, 3]);
  assert.equal(board.entries[0].nickname, "ArenaLb712");
  assert.equal(board.entries[0].bestArp, 2500);
  const top2 = await getArenaLeaderboard(2, 0);
  assert.equal(top2.entries.length, 2);
  assert.equal(top2.total, 3);
  const page2 = await getArenaLeaderboard(2, 2);
  assert.deepEqual(page2.entries.map((entry) => entry.aid), [711]);
  assert.deepEqual(page2.entries.map((entry) => entry.rank), [3]);
});

test("Arena leaderboard skips unrated, underplayed, and excluded accounts", async () => {
  resetArenaData();
  await save(profile(721, { bestArp: 2000 }));
  const unrated = profile(722, { bestArp: 0 });
  delete unrated.stat.arenaOverAllCounters.UnrankedOverall.Counters.BestArp;
  await save(unrated);
  await save(profile(723, { bestArp: 9999, games: 1 }));
  await save(profile(724, { bestArp: 8888 }));
  const db = new DatabaseSync(process.env.SQLITE_PATH);
  try {
    db.prepare("INSERT INTO excluded_players (aid, reason, created_at) VALUES (?, ?, ?)").run(724, "test", Date.now());
  } finally {
    db.close();
  }
  const board = await getArenaLeaderboard(10, 0);
  assert.ok(board);
  assert.deepEqual(board.entries.map((entry) => entry.aid), [721]);
  assert.equal(board.total, 1);
});

test("Arena leaderboard ties break by matches, then K/D", async () => {
  resetArenaData();
  await save(profile(731, { bestArp: 1500, games: 20, kills: 30, deaths: 30 }));
  await save(profile(732, { bestArp: 1500, games: 40, kills: 30, deaths: 30 }));
  const board = await getArenaLeaderboard(10, 0);
  assert.ok(board);
  assert.deepEqual(board.entries.map((entry) => entry.aid), [732, 731]);
});

test("Arena leaderboard rejects invalid limit and offset", async () => {
  resetArenaData();
  await assert.rejects(getArenaLeaderboard(0, 0), /invalid leaderboard limit/);
  await assert.rejects(getArenaLeaderboard(501, 0), /invalid leaderboard limit/);
  await assert.rejects(getArenaLeaderboard(10, -1), /invalid leaderboard offset/);
});
