import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createCohortFixture, DAY_MS } from "./rust-cohort-data.mjs";

export const ARENA_TEST_MODE = "lastHero";
export const SEASONAL_TEST_CYCLE = "native-s1";
export const ARENA_TEST_MODES = ["overall", "teamFight", "lastHero", "checkpoint", "blastGang", "shootOutDuo"];

export function arenaJob({ aid = 1, arenaMode = ARENA_TEST_MODE, statistic = "median" } = {}) {
  return { kind: "arena", args: [aid, arenaMode, statistic] };
}
export function arenaPopulationJob(input = {}) {
  return { kind: "arena_population", args: [{ mode: ARENA_TEST_MODE, statistic: "median",
    dimension: "matches", metric: "players", ...input }] };
}
export function seasonalJob({ aid = 1, cycleId = SEASONAL_TEST_CYCLE, dimension = "hours",
  statistic = "median", period = "all", now = Date.now() } = {}) {
  return { kind: "seasonal", args: [{ aid, cycleId, dimension, statistic, period }, now] };
}

export async function createArenaSeasonalFixture(prefix = "rust-arena-seasonal-") {
  const base = await createCohortFixture(prefix);
  const { ARENA_PARSER_VERSION } = await import("../../lib/arena/storage.ts");
  const { initializeSeasonalSchema } = await import("../../lib/seasonal/storage.ts");
  const playersDb = base.db;
  const seasonalDb = new DatabaseSync(process.env.PROGRESSION_SQLITE_PATH);
  seasonalDb.exec("PRAGMA journal_mode=WAL");
  initializeSeasonalSchema(seasonalDb);
  const arenaColumns = ["aid", "arena_mode", "hours", "games_count", "kd_ratio", "win_rate",
    "headshot_rate", "kills_per_match", "damage_per_match", "upstream_version", "parser_version", "raw_json", "fetched_at"];
  const arenaInsert = playersDb.prepare(`INSERT INTO arena_mode_stats (${arenaColumns.join(",")}) VALUES (${arenaColumns.map(() => "?").join(",")})`);
  const seasonalColumns = ["mode", "cycle_id", "aid", "nickname", "profile_updated_at", "last_access_at",
    "lifetime_pvp_hours", "experience", "pmc_raids", "scav_raids", "pmc_survived", "pmc_deaths", "pmc_kills",
    "killed_pmc", "pmc_killed_pmc", "pvp_stats_version", "total_raids", "survived", "deaths", "total_kills",
    "longest_win_streak", "level", "first_seen_at", "last_seen_at", "confirmed_banned"];
  const seasonalInsert = seasonalDb.prepare(`INSERT INTO player_profiles (${seasonalColumns.join(",")}) VALUES (${seasonalColumns.map(() => "?").join(",")})`);
  const cycleInsert = seasonalDb.prepare("INSERT OR IGNORE INTO season_cycles(mode,cycle_id,starts_at,enabled,upstream_contract) VALUES ('seasonal',?,1,1,'direct_profile')");
  function transact(db, rows, write) {
    db.exec("BEGIN");
    try { for (const row of rows) write(row); db.exec("COMMIT"); }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  return { directory: base.directory, playersDb, seasonalDb, parserVersion: ARENA_PARSER_VERSION,
    clearArena() { playersDb.exec("DELETE FROM arena_mode_stats; DELETE FROM excluded_players"); },
    clearSeasonal() { seasonalDb.exec("DELETE FROM player_profiles; DELETE FROM excluded_players; DELETE FROM season_cycles"); },
    seedArena(rows, now = Date.now()) {
      transact(playersDb, rows, (row) => {
        const complete = { arena_mode: ARENA_TEST_MODE, hours: 100, games_count: 100, kd_ratio: 2.5,
          win_rate: 50, headshot_rate: 25, kills_per_match: 20, damage_per_match: 500,
          upstream_version: 1, parser_version: ARENA_PARSER_VERSION, raw_json: "{}", fetched_at: now, ...row };
        arenaInsert.run(...arenaColumns.map((key) => complete[key]));
      });
    },
    seedSeasonal(rows, now = Date.now()) {
      transact(seasonalDb, rows, (row) => {
        const complete = { mode: "seasonal", cycle_id: SEASONAL_TEST_CYCLE, nickname: "synthetic",
          profile_updated_at: now - DAY_MS, last_access_at: now - DAY_MS, lifetime_pvp_hours: 100,
          experience: 1000, pmc_raids: 100, scav_raids: 20, pmc_survived: 50, pmc_deaths: 50,
          pmc_kills: 100, killed_pmc: 40, pmc_killed_pmc: 30, pvp_stats_version: 1,
          total_raids: 120, survived: 60, deaths: 60, total_kills: 240, longest_win_streak: 4,
          level: 25, first_seen_at: 1, last_seen_at: now, confirmed_banned: 0, ...row };
        cycleInsert.run(complete.cycle_id);
        seasonalInsert.run(...seasonalColumns.map((key) => complete[key]));
      });
    },
    close() { seasonalDb.close(); playersDb.close(); },
  };
}

export function* syntheticArenaRows(count, { arenaMode = ARENA_TEST_MODE } = {}) {
  for (let aid = 1; aid <= count; aid++) yield { aid, arena_mode: arenaMode,
    hours: arenaMode === "overall" ? null : 70 + ((aid * 17) % 601) / 10,
    games_count: 70 + ((aid * 7) % 61), kd_ratio: aid % 37 === 0 ? null : ((aid * 3) % 100) / 20,
    win_rate: 20 + ((aid * 11) % 80), headshot_rate: aid % 41 === 0 ? null : aid % 70,
    kills_per_match: 2 + ((aid * 13) % 100) / 10, damage_per_match: 100 + ((aid * 19) % 2500) };
}
export function* syntheticSeasonalRows(count, { cycleId = SEASONAL_TEST_CYCLE } = {}) {
  for (let aid = 1; aid <= count; aid++) {
    const raids = 20 + (aid * 13) % 1500;
    yield { aid, cycle_id: cycleId, lifetime_pvp_hours: 50 + (aid * 37) % 4950 + (aid % 10) / 10,
      pmc_raids: raids, pmc_survived: Math.floor(raids / 2), pmc_deaths: Math.floor(raids / 2),
      total_raids: raids + 20, survived: Math.floor(raids / 2), deaths: aid % 29 === 0 ? null : Math.floor(raids / 2),
      total_kills: aid % 31 === 0 ? null : (aid * 17) % 900, pmc_kills: (aid * 23) % 500,
      killed_pmc: (aid * 19) % 300, pmc_killed_pmc: aid % 23 === 0 ? null : (aid * 11) % 500,
      pvp_stats_version: aid % 17 === 0 ? 0 : 1, longest_win_streak: aid % 41, level: 1 + aid % 79 };
  }
}

export function seedArenaRouteOwners(fixture, startAid, count = 4) {
  const groups = { matched: [], population: [] };
  let aid = startAid;
  for (const [kind, arenaMode] of [["matched", ARENA_TEST_MODE], ["population", "overall"]]) {
    const rows = [];
    for (let i = 0; i < count; i++, aid++) {
      rows.push({ aid, arena_mode: arenaMode, hours: arenaMode === "overall" ? null : 100, games_count: 100 });
      groups[kind].push(aid);
    }
    fixture.seedArena(rows);
  }
  return groups;
}
export function seedSeasonalRouteOwners(fixture, startAid, count = 4, cycleId = SEASONAL_TEST_CYCLE, now = Date.now()) {
  const groups = { matched: [], population: [] };
  let aid = startAid;
  for (const [kind, hours, raids] of [["matched", 1000, 500], ["population", 1e8, 1e8]]) {
    const rows = [];
    for (let i = 0; i < count; i++, aid++) {
      rows.push({ aid, cycle_id: cycleId, lifetime_pvp_hours: hours, pmc_raids: raids });
      groups[kind].push(aid);
    }
    fixture.seedSeasonal(rows, now);
  }
  return groups;
}

// Match every field exactly except final averages and coverage fractions. These
// may differ in last-bit rounding between SQLite/JavaScript and Rust summation.
export function assertNativeParity(actual, expected, context = "native cohort") {
  const normalized = structuredClone(actual);
  function normalize(got, wanted, path) {
    if (typeof wanted === "number" && (path.endsWith(".value") || path.includes(".coverage."))) {
      assert.equal(typeof got, "number", `${context}: ${path}`);
      assert.ok(Number.isFinite(got) && Math.abs(got - wanted) <= 1e-12 * Math.max(1, Math.abs(wanted)),
        `${context}: ${path}: ${got} != ${wanted}`);
      return wanted;
    }
    if (wanted && typeof wanted === "object") {
      assert.ok(got && typeof got === "object", `${context}: missing ${path}`);
      for (const [key, value] of Object.entries(wanted)) got[key] = normalize(got[key], value, `${path}.${key}`);
    }
    return got;
  }
  assert.deepEqual(normalize(normalized, expected, "result"), expected, context);
}
