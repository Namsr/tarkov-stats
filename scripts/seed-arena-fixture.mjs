import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArenaProfileStats } from "../lib/tarkov-api.ts";
import { initializeArenaSchema, upsertArenaSqlite } from "../lib/arena/storage.ts";

const dbFlag = process.argv.indexOf("--db");
const requestedPath = dbFlag >= 0 ? process.argv[dbFlag + 1] : null;
if (!requestedPath) throw new Error("use --db <new isolated sqlite path>");
const dbPath = resolve(requestedPath);
if (existsSync(dbPath)) throw new Error(`refusing to overwrite ${dbPath}`);
mkdirSync(dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec(`
CREATE TABLE excluded_players (aid INTEGER PRIMARY KEY, reason TEXT, created_at INTEGER);
CREATE TABLE mode_players (
  mode TEXT NOT NULL, aid INTEGER NOT NULL,
  nickname TEXT, side TEXT, prestige INTEGER DEFAULT 0, level INTEGER DEFAULT 0,
  experience INTEGER DEFAULT 0, hours REAL DEFAULT 0, bracket_key TEXT,
  total_raids INTEGER DEFAULT 0, pmc_raids INTEGER DEFAULT 0, scav_raids INTEGER DEFAULT 0,
  survived INTEGER DEFAULT 0, deaths INTEGER DEFAULT 0, pmc_deaths INTEGER DEFAULT 0,
  total_kills INTEGER DEFAULT 0, killed_pmc INTEGER DEFAULT 0, run_through INTEGER DEFAULT 0,
  longest_win_streak INTEGER DEFAULT 0, kd_ratio REAL DEFAULT 0, pmc_kd_ratio REAL DEFAULT 0,
  survival_rate REAL DEFAULT 0, kills_per_raid REAL DEFAULT 0,
  pmc_survival_rate REAL DEFAULT 0, pmc_kills_per_raid REAL DEFAULT 0, achv_count INTEGER DEFAULT 0,
  achievements TEXT, profile_updated_at INTEGER DEFAULT 0, pvp_stats_known INTEGER DEFAULT 0,
  fetched_at INTEGER NOT NULL, stats_json TEXT NOT NULL,
  PRIMARY KEY (mode, aid)
);
`);
initializeArenaSchema(db);

const modeNames = [
  ["UnrankedTeamFight", "teamFight"],
  ["UnrankedLastHero", "lastHero"],
  ["UnrankedCheckPoint", "checkpoint"],
  ["UnrankedBlastGang", "blastGang"],
  ["UnrankedShootOutDuo", "shootOutDuo"],
];

function group(games, kills, deaths, options = {}) {
  return { Counters: {
    GamesCount: games,
    ArenaWins: options.wins ?? Math.floor(games * 0.55),
    ArenaLoses: options.losses ?? Math.floor(games * 0.4),
    Kills: kills,
    Deaths: deaths,
    Assists: options.assists ?? Math.floor(kills * 0.3),
    Headshots: options.headshots ?? Math.floor(kills * 0.2),
    DamageDealt: options.damage ?? kills * 420,
    RoundMvpCount: 2,
    MatchMvpCount: 1,
    KillsWithoutDeaths: 3,
    MaxKillsWithoutDeaths: 8,
    WinStreak: 2,
    LongestWinStreak: 5,
    LoseStreak: 1,
    LongestLoseStreak: 3,
  } };
}

function totals(groups) {
  const counters = {};
  for (const entry of groups) {
    for (const [key, value] of Object.entries(entry.Counters)) {
      if (key.startsWith("Max") || key.startsWith("Longest")) counters[key] = Math.max(counters[key] ?? 0, value);
      else if (key === "KillsWithoutDeaths" || key === "WinStreak" || key === "LoseStreak") counters[key] = value;
      else counters[key] = (counters[key] ?? 0) + value;
    }
  }
  // BestArp is a rating, not a sum. Derive a deterministic per-profile value
  // from the fixture totals so seeded DBs have leaderboard data.
  const kills = counters.Kills ?? 0;
  const deaths = counters.Deaths ?? 0;
  const wins = counters.ArenaWins ?? 0;
  const games = counters.GamesCount ?? 0;
  counters.BestArp = 1000 + kills * 5 + wins * 3 - deaths + (games % 7);
  return { Counters: counters };
}

function profile(aid, { partial = false, extreme = false } = {}) {
  const games = 20 + (aid % 3);
  const kills = extreme ? 160 : 21 + (aid % 4);
  const deaths = extreme ? 8 : 19 + (aid % 3);
  const groups = modeNames.map(([, key], index) => [key, group(games, kills + index, deaths + (index % 2))]);
  const counters = Object.fromEntries(groups);
  if (partial) delete counters.shootOutDuo;
  const allGroups = Object.values(counters);
  return {
    aid,
    updated: 1_800_000_000_000 + aid,
    info: { nickname: `ArenaFixture${aid}`, side: "Usec", experience: 0 },
    stat: {
      totalInGameTime: (99 + (aid % 3)) * 3_600,
      arenaOverAllCounters: { UnrankedOverall: totals(allGroups), ...Object.fromEntries(
        modeNames.map(([upstream, key]) => [upstream, counters[key]])
      ) },
    },
  };
}

const insertLegacy = db.prepare(`INSERT INTO mode_players
  (mode, aid, nickname, side, hours, profile_updated_at, fetched_at, stats_json)
  VALUES ('arena', ?, ?, 'Usec', ?, ?, ?, ?)`);

function save(source, legacyOnly = false) {
  const stats = parseArenaProfileStats(source);
  const now = Date.now();
  if (!legacyOnly) upsertArenaSqlite(db, stats.arenaProfile, now);
  const legacyStats = legacyOnly
    ? { ...stats, arenaProfile: undefined, arena: { ...stats.arena, modes: stats.arena.modes.slice(0, 4) } }
    : stats;
  insertLegacy.run(
    source.aid,
    stats.nickname,
    stats.hoursPlayed,
    stats.profileUpdatedAt,
    now,
    JSON.stringify(legacyStats),
  );
}

for (let aid = 2; aid <= 36; aid += 1) save(profile(aid));
save(profile(1, { extreme: true }));
save(profile(9001, { partial: true }));
save(profile(9002), true);
db.close();
console.log(`Arena fixture created at ${dbPath}`);
