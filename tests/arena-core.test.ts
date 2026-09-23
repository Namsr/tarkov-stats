/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- The direct Node runner uses the same path hook as Arena route tests.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

const directory = mkdtempSync(join(tmpdir(), "tarkov-arena-core-"));
process.env.SQLITE_PATH = join(directory, "players.db");
process.env.BANS_SQLITE_PATH = join(directory, "bans.db");

const { getStore } = await import("../lib/db.ts");
const { parseArenaProfileStats } = await import("../lib/tarkov-api.ts");
const { getArenaAverage, getArenaCohort, getArenaProfile, getArenaProfileRisk } = await import("../lib/arena/service.ts");
const {
  ARENA_HISTORY_INSERT_SQL,
  ARENA_PARSER_VERSION,
  ARENA_UPSERT_SQL,
  arenaUpsertStatements,
  initializeArenaSchema,
  upsertArenaSqlite,
} = await import("../lib/arena/storage.ts");

const modeNames = [
  "UnrankedTeamFight",
  "UnrankedLastHero",
  "UnrankedCheckPoint",
  "UnrankedBlastGang",
  "UnrankedShootOutDuo",
];

function group(games, kills, deaths, { headshots = Math.floor(kills / 4), future = false } = {}) {
  return { Counters: {
    GamesCount: games, ArenaWins: Math.floor(games / 2), ArenaLoses: Math.floor(games / 3),
    Kills: kills, Deaths: deaths, Assists: 2, ...(headshots === null ? {} : { Headshots: headshots }),
    DamageDealt: kills * 400, RoundMvpCount: 2, MatchMvpCount: 1,
    KillsWithoutDeaths: 2, MaxKillsWithoutDeaths: 7, WinStreak: 2,
    LongestWinStreak: 5, LoseStreak: 1, LongestLoseStreak: 3,
    ...(future ? { FutureCounter: 17 } : {}),
  } };
}

function profile(aid, {
  updated = 1_800_000_000_000 + aid,
  kills = 22,
  deaths = 20,
  games = 20,
  hours = 100,
  headshots,
  missingMode = false,
  future = false,
} = {}) {
  const modes = Object.fromEntries(modeNames.map((name, index) => [
    name,
    missingMode && index === 4 ? undefined : group(games, kills + index, deaths, { headshots, future: future && index === 0 }),
  ]));
  return {
    aid,
    updated,
    info: { nickname: `Arena${aid}`, side: "Usec", experience: 0 },
    stat: {
      totalInGameTime: hours * 3_600,
      arenaOverAllCounters: {
        UnrankedOverall: group(games * 5, kills * 5 + 10, deaths * 5, { headshots, future }),
        ...modes,
      },
    },
  };
}

function resetArenaData() {
  const db = new DatabaseSync(process.env.SQLITE_PATH);
  try {
    db.exec("DROP TRIGGER IF EXISTS arena_fixture_failure; DELETE FROM arena_risk_evaluations; DELETE FROM arena_mode_stats_history; DELETE FROM arena_mode_stats; DELETE FROM mode_players WHERE mode = 'arena'; DELETE FROM excluded_players");
  } finally {
    db.close();
  }
}

async function save(source) {
  const store = await getStore("arena");
  assert.ok(store);
  await store.upsert(source.aid, parseArenaProfileStats(source), []);
}

test("Arena parser preserves zeroes, missing counters, source counters, and incomplete fifth modes", () => {
  const parsed = parseArenaProfileStats(profile(501, { kills: 0, deaths: 0, headshots: null, missingMode: true, future: true }));
  const arena = parsed.arenaProfile;
  assert.equal(arena.modes.teamFight.counters.kills, 0);
  assert.equal(arena.modes.teamFight.metrics.kd_ratio, null);
  assert.equal(arena.modes.teamFight.counters.headshots, null);
  assert.equal(arena.modes.shootOutDuo.counters.matches, 0);
  assert.equal(arena.overall.counters.headshots, null);
});

test("Arena parser computes five exact formulas and rejects invalid raw counter values", () => {
  const source = profile(510);
  source.stat.arenaOverAllCounters.UnrankedTeamFight = { Counters: {
    GamesCount: 10, ArenaWins: 6, ArenaLoses: 3, Kills: 20, Deaths: 4,
    Headshots: 5, DamageDealt: 2_000, Assists: 0,
  } };
  const team = parseArenaProfileStats(source).arenaProfile.modes.teamFight;
  assert.equal(team.metrics.kd_ratio, 5);
  assert.equal(team.metrics.win_rate, 60);
  assert.equal(team.metrics.headshot_rate, 25);
  assert.equal(team.metrics.kills_per_match, 2);
  assert.equal(team.metrics.damage_per_match, 200);
  assert.equal(team.counters.assists, 0);

  source.stat.totalInGameTime = Number.NaN;
  source.stat.arenaOverAllCounters.UnrankedTeamFight = { Counters: {
    GamesCount: 10, ArenaWins: 11, ArenaLoses: -1, Kills: "20", Deaths: Infinity,
    Headshots: 30, DamageDealt: -5,
  } };
  const invalid = parseArenaProfileStats(source).arenaProfile;
  assert.equal(invalid.overall.hours, null);
  assert.equal(invalid.modes.teamFight.counters.kills, null);
  assert.equal(invalid.modes.teamFight.counters.losses, null);
  assert.equal(invalid.modes.teamFight.metrics.kd_ratio, null);
  assert.equal(invalid.modes.teamFight.metrics.win_rate, null);
  assert.equal(invalid.modes.teamFight.metrics.headshot_rate, null);
  assert.equal(invalid.modes.teamFight.metrics.damage_per_match, null);

  source.stat.arenaOverAllCounters.UnrankedTeamFight = { Counters: {
    GamesCount: 10.5, ArenaWins: 5, Kills: 20, Deaths: 4, DamageDealt: 2_000.5,
  } };
  const fractional = parseArenaProfileStats(source).arenaProfile.modes.teamFight;
  assert.equal(fractional.counters.matches, null);
  assert.equal(fractional.counters.damage, 2_000.5);
  assert.equal(fractional.metrics.kills_per_match, null);
});

test("Arena overall falls back to complete played-mode totals and maxima", () => {
  const source = profile(511);
  for (const [index, name] of modeNames.entries()) {
    const counters = source.stat.arenaOverAllCounters[name].Counters;
    counters.Kills = 10 + index;
    counters.MaxKillsWithoutDeaths = 20 + index;
  }
  source.stat.arenaOverAllCounters.UnrankedOverall = { Counters: { GamesCount: 100 } };
  const complete = parseArenaProfileStats(source).arenaProfile;
  assert.equal(complete.overall.source, "upstream");
  assert.equal(complete.overall.counters.kills, 60);
  assert.equal(complete.overall.counters.max_kill_streak, 24);
  assert.equal(complete.overall.counters.current_kill_streak, null);

  const shootOutDuo = source.stat.arenaOverAllCounters.UnrankedShootOutDuo;
  source.stat.arenaOverAllCounters.UnrankedShootOutDuo = undefined;
  source.stat.arenaOverAllCounters.UnrankedOverall = { Counters: { GamesCount: 80 } };
  const unplayed = parseArenaProfileStats(source).arenaProfile;
  assert.equal(unplayed.modes.shootOutDuo.counters.matches, 0);
  assert.equal(unplayed.overall.counters.matches, 80);
  assert.equal(unplayed.overall.counters.wins, 40);
  assert.equal(unplayed.overall.counters.losses, 24);
  assert.equal(unplayed.overall.counters.kills, 46);
  assert.equal(unplayed.overall.counters.assists, 8);
  assert.equal(unplayed.overall.counters.headshots, 22);
  assert.equal(unplayed.overall.counters.damage, 37_600);
  assert.equal(unplayed.overall.counters.round_mvp, 8);
  assert.equal(unplayed.overall.counters.match_mvp, 4);
  assert.equal(unplayed.overall.counters.max_kill_streak, 23);

  source.stat.arenaOverAllCounters.UnrankedShootOutDuo = shootOutDuo;
  delete shootOutDuo.Counters.DamageDealt;
  const partial = parseArenaProfileStats(source).arenaProfile.overall;
  assert.equal(partial.counters.damage, null);
  assert.equal(partial.metrics.damage_per_match, null);
});

test("Arena overall includes modes with unknown match counts", () => {
  const source = profile(512);
  for (const [index, name] of modeNames.entries()) {
    source.stat.arenaOverAllCounters[name].Counters.Kills = index === 0 ? 10 : 0;
  }
  source.stat.arenaOverAllCounters.UnrankedShootOutDuo = { Counters: { Kills: 7 } };
  source.stat.arenaOverAllCounters.UnrankedOverall = { Counters: { GamesCount: 10 } };
  const arena = parseArenaProfileStats(source).arenaProfile;
  assert.equal(arena.modes.shootOutDuo.counters.matches, null);
  assert.equal(arena.overall.counters.kills, 17);
  assert.equal(arena.overall.counters.assists, null);
  assert.equal(arena.overall.counters.max_kill_streak, null);
});

test("Arena storage writes all modes atomically, keeps nulls, and rejects stale versions", async () => {
  const store = await getStore("arena");
  assert.ok(store);
  const newest = profile(502, { updated: 1_800_000_009_000, future: true, headshots: null });
  await store.upsert(502, parseArenaProfileStats(newest), []);
  await store.upsert(502, parseArenaProfileStats(profile(502, { updated: 1_800_000_008_999, kills: 999 })), []);
  const db = new DatabaseSync(process.env.SQLITE_PATH);
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM arena_mode_stats WHERE aid = 502").get().n, 6);
    assert.equal(db.prepare("SELECT profile_updated_at FROM mode_players WHERE mode = 'arena' AND aid = 502").get().profile_updated_at, 1_800_000_009_000);
    assert.equal(db.prepare("SELECT kills FROM arena_mode_stats WHERE aid = 502 AND arena_mode = 'teamFight'").get().kills, 22);
    assert.deepEqual(db.prepare(`SELECT upstream_version FROM arena_mode_stats_history
      WHERE aid = 502 AND arena_mode = 'teamFight' ORDER BY upstream_version`).all()
      .map((row) => Number(row.upstream_version)), [1_800_000_008_999, 1_800_000_009_000]);
    const raw = JSON.parse(db.prepare("SELECT raw_json FROM arena_mode_stats WHERE aid = 502 AND arena_mode = 'teamFight'").get().raw_json);
    assert.equal(raw.sourceCounters.Counters.FutureCounter, 17);
  } finally {
    db.close();
  }
  const normalized = await getArenaProfile(502);
  assert.equal(normalized?.modes.teamFight.counters.headshots, null);
});

test("Arena history migration backfills current snapshots once and is idempotent", () => {
  const migration = readFileSync("scripts/arena-history-d1.sql", "utf8");
  const memory = new DatabaseSync(":memory:");
  try {
    memory.exec("CREATE TABLE excluded_players (aid INTEGER PRIMARY KEY)");
    initializeArenaSchema(memory);
    upsertArenaSqlite(memory, parseArenaProfileStats(profile(503)).arenaProfile, 123);
    memory.exec("DROP TABLE arena_mode_stats_history");
    memory.exec(migration);
    assert.equal(memory.prepare("SELECT COUNT(*) AS n FROM arena_mode_stats_history WHERE aid = 503").get().n, 6);
    memory.exec(migration);
    assert.equal(memory.prepare("SELECT COUNT(*) AS n FROM arena_mode_stats_history WHERE aid = 503").get().n, 6);
  } finally {
    memory.close();
  }
});

test("Arena schema adds BestArp before its index and preserves legacy rows", () => {
  const legacySchema = readFileSync("scripts/arena-storage-d1.sql", "utf8")
    .replace(/  best_arp REAL,\r?\n/g, "")
    .replace(/CREATE INDEX IF NOT EXISTS idx_arena_mode_stats_best_arp\r?\n  ON arena_mode_stats\(arena_mode, best_arp DESC\);?\r?\n/g, "");
  const memory = new DatabaseSync(":memory:");
  try {
    memory.exec("CREATE TABLE excluded_players (aid INTEGER PRIMARY KEY)");
    memory.exec(legacySchema);
    memory.prepare(`INSERT INTO arena_mode_stats
      (aid,arena_mode,hours,upstream_version,parser_version,raw_json,fetched_at)
      VALUES (504,'overall',10,100,1,'{}',200)`).run();
    memory.exec(readFileSync("scripts/arena-risk-index-d1.sql", "utf8"));
    initializeArenaSchema(memory);
    initializeArenaSchema(memory);
    assert.equal(memory.prepare("SELECT COUNT(*) n FROM arena_mode_stats WHERE aid=504").get().n, 1);
    assert.ok(memory.prepare("PRAGMA table_info(arena_mode_stats)").all().some((row) => row.name === "best_arp"));
    assert.ok(memory.prepare("PRAGMA table_info(arena_mode_stats_history)").all().some((row) => row.name === "best_arp"));
    assert.ok(memory.prepare(`SELECT 1 FROM sqlite_master
      WHERE type='index' AND name='idx_arena_mode_stats_best_arp'`).get());
    const comparisonColumns = ["arena_mode", "parser_version", "games_count", "hours", "aid",
      "kd_ratio", "win_rate", "headshot_rate", "kills_per_match", "damage_per_match"];
    assert.deepEqual(memory.prepare("PRAGMA index_info(idx_arena_mode_stats_comparison)").all().map((row) => row.name), comparisonColumns);
    assert.equal(memory.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_arena_mode_stats_mode_parser'").get(), undefined);
    memory.exec("DROP INDEX idx_arena_mode_stats_comparison");
    const migration = readFileSync("scripts/arena-comparison-index-d1.sql", "utf8");
    memory.exec(migration);
    memory.exec(migration);
    assert.deepEqual(memory.prepare("PRAGMA index_info(idx_arena_mode_stats_comparison)").all().map((row) => row.name), comparisonColumns);
    assert.equal(memory.prepare("SELECT COUNT(*) n FROM arena_mode_stats WHERE aid=504").get().n, 1);
  } finally {
    memory.close();
  }
});

test("Arena averages, cohort, and display-only risk use current eligible snapshots", async () => {
  const store = await getStore("arena");
  assert.ok(store);
  const reset = new DatabaseSync(process.env.SQLITE_PATH);
  try {
    reset.exec("DELETE FROM arena_risk_evaluations; DELETE FROM arena_mode_stats_history; DELETE FROM arena_mode_stats; DELETE FROM mode_players WHERE mode = 'arena'");
  } finally {
    reset.close();
  }
  for (let aid = 1; aid <= 32; aid += 1) {
    const extreme = aid === 1;
    await store.upsert(aid, parseArenaProfileStats(profile(aid, {
      kills: extreme ? 120 : 20 + (aid % 4),
      deaths: extreme ? 8 : 19 + (aid % 3),
      headshots: aid === 32 ? null : undefined,
    })), []);
  }
  const average = await getArenaAverage({ mode: "teamFight", statistic: "median" });
  assert.equal(average?.filterIdentity.dimension, "matches");
  assert.equal(average?.sampleN, 32);
  assert.equal(average?.metrics.headshot_rate.count, 31);
  const cohort = await getArenaCohort(1, "teamFight", "trimmed_mean");
  assert.equal(cohort?.quality, "sufficient");
  assert.equal(cohort?.sampleN, 31);
  assert.equal(cohort?.metrics.kd_ratio.count, 31);
  const risk = await getArenaProfileRisk(1);
  assert.ok((risk?.score ?? 0) > 0);
  assert.ok(risk?.modes.some((mode) => mode.reasons.some((reason) => reason.startsWith("high_"))));
  assert.equal(risk?.freshness.profileUpdatedAt, 1_800_000_000_001);
  assert.ok((risk?.freshness.evaluatedAt ?? 0) > 0);
});

test("Arena average trims at 20, preserves exact median, and excludes fewer than ten games", async () => {
  resetArenaData();
  for (let aid = 1; aid <= 19; aid += 1) await save(profile(aid, { kills: aid, deaths: 1 }));
  let average = await getArenaAverage({ mode: "teamFight", statistic: "trimmed_mean" });
  assert.equal(average?.metrics.kd_ratio.value, 10);
  await save(profile(20, { kills: 1_000, deaths: 1 }));
  average = await getArenaAverage({ mode: "teamFight", statistic: "trimmed_mean" });
  assert.equal(average?.metrics.kd_ratio.value, 10.5);
  const median = await getArenaAverage({ mode: "teamFight", statistic: "median" });
  assert.equal(median?.metrics.kd_ratio.value, 10.5);

  resetArenaData();
  await save(profile(31, { games: 9 }));
  await save(profile(32, { games: 10 }));
  const threshold = await getArenaAverage({ mode: "teamFight" });
  assert.equal(threshold?.sampleN, 1);
  assert.equal(threshold?.metrics.kd_ratio.reason, null);
});

test("Arena analytics use normalized metrics without loading raw payloads or counters", async () => {
  resetArenaData();
  for (let aid = 1; aid <= 31; aid += 1) {
    await save(profile(aid, { kills: 20 + aid, deaths: 20 }));
  }
  const { getArenaBackend } = await import("../lib/db.ts");
  const backend = await getArenaBackend();
  assert.equal(backend.kind, "sqlite");
  const prepare = backend.db.prepare;
  const projections = [];
  backend.db.prepare = function (sql) {
    if (/FROM arena_mode_stats WHERE/.test(sql) && /^SELECT aid, hours/.test(sql)) {
      projections.push(sql.slice(0, sql.indexOf("FROM arena_mode_stats")));
    }
    return prepare.call(this, sql);
  };
  try {
    for (const mode of ["overall", "teamFight"]) {
      for (const statistic of ["trimmed_mean", "median"]) {
        const average = await getArenaAverage({ mode, statistic });
        const cohort = await getArenaCohort(1, mode, statistic);
        assert.equal(average.sampleN, 31);
        assert.equal(cohort.sampleN, 30);
        assert.equal(cohort.quality, "sufficient");
        assert.ok(cohort.metrics.kd_ratio.value > 0);
      }
    }
    const risk = await getArenaProfileRisk(1);
    assert.equal(risk.overall.peerCount, 30);
    assert.equal(risk.modes[0].peerCount, 30);
    assert.ok(projections.length > 0);
    for (const projection of projections) {
      assert.doesNotMatch(projection, /\b(raw_json|arena_wins|kills|deaths|damage_dealt|max_kill_streak)\b|\*/);
      assert.match(projection, /kd_ratio/);
      assert.match(projection, /parser_version/);
    }
    const stored = await getArenaProfile(1);
    assert.equal(stored.modes.teamFight.counters.kills, 21);
    assert.equal(stored.overall.source, "upstream");
  } finally {
    backend.db.prepare = prepare;
  }
});

test("Arena population counts parsed accounts and distinct players independently of average filters", async () => {
  resetArenaData();
  await save(profile(601, { games: 0 }));
  await save(profile(602, { games: null }));
  await save(profile(603, { games: 1 }));
  await save(profile(604, { games: 9 }));
  await save(profile(605, { games: 10 }));
  await save(profile(606, { games: 10 }));
  await save(profile(607, { games: -1 }));

  const stale = parseArenaProfileStats(profile(608, { games: 10 })).arenaProfile;
  stale.parserVersion = 0;
  const staleDb = new DatabaseSync(process.env.SQLITE_PATH);
  try {
    upsertArenaSqlite(staleDb, stale, 1);
    staleDb.prepare("INSERT INTO excluded_players (aid, reason, created_at) VALUES (?, ?, ?)")
      .run(605, "fixture", 1);
  } finally {
    staleDb.close();
  }

  const unfiltered = await getArenaAverage({ mode: "teamFight" });
  assert.deepEqual(unfiltered?.population, {
    scannedAccounts: 6,
    playedAccounts: {
      teamFight: 3,
      lastHero: 3,
      checkpoint: 3,
      blastGang: 3,
      shootOutDuo: 3,
    },
  });
  assert.equal(unfiltered?.sampleN, 1);

  const filtered = await getArenaAverage({
    mode: "teamFight", statistic: "median", dimension: "hours", metric: "kd_ratio",
    minHours: 100, maxHours: 100, minMatches: 10, maxMatches: 10,
  });
  assert.deepEqual(filtered?.population, unfiltered?.population);

  resetArenaData();
  await save(profile(609, { games: 0 }));
  const partialDb = new DatabaseSync(process.env.SQLITE_PATH);
  try {
    partialDb.prepare("DELETE FROM arena_mode_stats WHERE arena_mode <> 'overall'").run();
  } finally {
    partialDb.close();
  }
  const zeroFilled = await getArenaAverage({ mode: "teamFight" });
  assert.deepEqual(zeroFilled?.population, {
    scannedAccounts: 1,
    playedAccounts: {
      teamFight: 0,
      lastHero: 0,
      checkpoint: 0,
      blastGang: 0,
      shootOutDuo: 0,
    },
  });
});

test("Arena cohort expands both axes, excludes self and global fallbacks, and requires 20 values per metric", async () => {
  resetArenaData();
  await save(profile(100, { games: 20, hours: 100 }));
  for (let aid = 101; aid <= 119; aid += 1) await save(profile(aid, { games: 20, hours: 100 }));
  await save(profile(120, { games: 22, hours: 114, headshots: null }));
  for (let aid = 200; aid < 230; aid += 1) await save(profile(aid, { games: 200, hours: 100 }));
  let cohort = await getArenaCohort(100, "teamFight");
  assert.equal(cohort?.strategy, "matched");
  assert.equal(cohort?.percent, 15);
  assert.equal(cohort?.sampleN, 20);
  assert.equal(cohort?.metrics.headshot_rate.count, 19);
  assert.equal(cohort?.metrics.headshot_rate.value, null);
  assert.equal(cohort?.metrics.headshot_rate.reason, "insufficient_values");
  await save(profile(120, { games: 22, hours: 114, updated: 1_800_000_000_120 }));
  cohort = await getArenaCohort(100, "teamFight");
  assert.equal(cohort?.sampleN, 20);
  assert.equal(cohort?.metrics.headshot_rate.count, 20);
  assert.notEqual(cohort?.metrics.headshot_rate.value, null);
});

test("Arena overall cohort uses eligible population rows, excludes its target, and keeps per-metric samples", async () => {
  resetArenaData();
  const target = profile(700, { games: 2, hours: 1, kills: 999, deaths: 1 });
  target.stat.arenaOverAllCounters.UnrankedOverall.Counters.Kills = 999;
  target.stat.arenaOverAllCounters.UnrankedOverall.Counters.Deaths = 1;
  await save(target);
  for (let offset = 1; offset <= 20; offset += 1) {
    const peer = profile(700 + offset, { games: 2, hours: 10_000, kills: offset, deaths: 1 });
    const counters = peer.stat.arenaOverAllCounters.UnrankedOverall.Counters;
    counters.Kills = offset === 20 ? 1_000 : offset;
    counters.Deaths = 1;
    counters.Headshots = 0;
    if (offset === 1) delete counters.Headshots;
    await save(peer);
  }
  const belowMinimum = profile(800, { games: 1, hours: 10_000, kills: 99_999, deaths: 1 });
  belowMinimum.stat.arenaOverAllCounters.UnrankedOverall.Counters.Kills = 99_999;
  belowMinimum.stat.arenaOverAllCounters.UnrankedOverall.Counters.Deaths = 1;
  await save(belowMinimum);

  const trimmed = await getArenaCohort(700, "overall", "trimmed_mean");
  const median = await getArenaCohort(700, "overall", "median");
  assert.equal(trimmed?.strategy, "population");
  assert.equal(trimmed?.target.matches, 10);
  assert.equal(trimmed?.sampleN, 20);
  assert.equal(trimmed?.quality, "sufficient");
  assert.equal(trimmed?.metrics.kd_ratio.count, 20);
  assert.equal(trimmed?.metrics.kd_ratio.value, 10.5);
  assert.equal(median?.metrics.kd_ratio.value, 10.5);
  assert.equal(trimmed?.metrics.headshot_rate.count, 19);
  assert.equal(trimmed?.metrics.headshot_rate.reason, "insufficient_values");
});

test("Arena risk needs 30 peers, ignores headshots, preserves mode scores, and roots in overall", async () => {
  resetArenaData();
  await save(profile(300, { kills: 120, deaths: 8 }));
  for (let aid = 301; aid <= 329; aid += 1) await save(profile(aid, { kills: 20 + (aid % 4), deaths: 20 }));
  let risk = await getArenaProfileRisk(300);
  assert.equal(risk?.score, null);
  assert.equal(risk?.score, risk?.overall.score);
  assert.equal(risk?.overall.peerCount, 29);
  assert.equal(risk?.overall.metrics.kd_ratio.count, 29);
  assert.equal(risk?.overall.metrics.kd_ratio.reason, "insufficient_peers");
  assert.equal(risk?.modes[0].peerCount, 29);
  assert.ok(risk?.modes[0].reasons.includes("insufficient_peers"));
  await save(profile(330, { kills: 22, deaths: 20 }));
  risk = await getArenaProfileRisk(300);
  assert.ok((risk?.score ?? 0) > 0);
  assert.equal(risk?.score, risk?.overall.score);
  assert.equal(risk?.overall.peerCount, 30);
  assert.equal(risk?.overall.metrics.kd_ratio.count, 30);
  assert.ok(risk?.modes.some((mode) => mode.reasons.some((reason) => reason.startsWith("high_"))));
  const riskDb = new DatabaseSync(process.env.SQLITE_PATH);
  try {
    const saved = JSON.parse(riskDb.prepare("SELECT risk_json FROM arena_risk_evaluations WHERE aid = 300").get().risk_json);
    assert.equal(saved.version.calculation, 3);
  } finally {
    riskDb.close();
  }

  resetArenaData();
  await save(profile(340, { kills: 20, deaths: 20, headshots: 9_999 }));
  for (let aid = 341; aid <= 370; aid += 1) await save(profile(aid, { kills: 20, deaths: 20, headshots: 1 }));
  risk = await getArenaProfileRisk(340);
  assert.equal(risk?.score, null);
  assert.equal(risk?.overall.metrics.headshot_rate, undefined);
  assert.equal(risk?.modes[0].metrics.kd_ratio.reason, "zero_std");
  assert.equal(risk?.modes[0].metrics.headshot_rate, undefined);

  resetArenaData();
  await save(profile(380));
  const target = profile(380);
  target.stat.arenaOverAllCounters.UnrankedTeamFight = group(20, 120, 8);
  await save(target);
  for (let aid = 381; aid <= 411; aid += 1) await save(profile(aid, { kills: 20 + (aid % 4), deaths: 20 }));
  const median = await getArenaAverage({ mode: "teamFight", statistic: "median" });
  const oneMode = await getArenaProfileRisk(380);
  const trimmed = await getArenaAverage({ mode: "teamFight", statistic: "trimmed_mean" });
  const afterUiStatistic = await getArenaProfileRisk(380);
  const teamFight = oneMode?.modes.find((mode) => mode.mode === "teamFight");
  assert.ok((teamFight?.score ?? 0) > 0);
  assert.equal(oneMode?.score, oneMode?.overall.score);
  assert.notEqual(oneMode?.score, teamFight?.score);
  assert.equal(afterUiStatistic?.score, oneMode?.score);
  assert.notEqual(median?.metrics.kd_ratio.value, trimmed?.metrics.kd_ratio.value);

  resetArenaData();
  await save(profile(420, { kills: 1, deaths: 10 }));
  for (let aid = 421; aid <= 450; aid += 1) await save(profile(aid, { kills: 1, deaths: 10 }));
  const decimalVariance = await getArenaProfileRisk(420);
  assert.equal(decimalVariance?.score, null);
  assert.equal(decimalVariance?.modes[0].metrics.kd_ratio.reason, "zero_std");

  resetArenaData();
  const missingTargetMetric = profile(460);
  delete missingTargetMetric.stat.arenaOverAllCounters.UnrankedTeamFight.Counters.Kills;
  await save(missingTargetMetric);
  for (let aid = 461; aid <= 490; aid += 1) await save(profile(aid));
  const missingMetric = await getArenaProfileRisk(460);
  const missingTeamFight = missingMetric?.modes.find((mode) => mode.mode === "teamFight");
  assert.equal(missingTeamFight?.metrics.kd_ratio.reason, "missing_metric");
  assert.equal(missingTeamFight?.metrics.kd_ratio.count, 30);

  for (const { aid, damagePerMatch, z, points } of [
    { aid: 500, damagePerMatch: 250, z: 2, points: 0 },
    { aid: 600, damagePerMatch: 350, z: 4, points: 50 },
    { aid: 700, damagePerMatch: 450, z: 6, points: 100 },
  ]) {
    resetArenaData();
    const damageOnlyTarget = profile(aid, { kills: 20, deaths: 20, headshots: 9_999 });
    damageOnlyTarget.stat.arenaOverAllCounters.UnrankedTeamFight.Counters.DamageDealt = damagePerMatch * 20;
    await save(damageOnlyTarget);
    for (let offset = 1; offset <= 30; offset += 1) {
      const peer = profile(aid + offset, { kills: 20, deaths: 20 });
      peer.stat.arenaOverAllCounters.UnrankedTeamFight.Counters.DamageDealt = offset <= 15 ? 2_000 : 4_000;
      await save(peer);
    }
    const damageOnly = await getArenaProfileRisk(aid);
    const damageTeamFight = damageOnly?.modes.find((mode) => mode.mode === "teamFight");
    assert.deepEqual(Object.keys(damageTeamFight?.metrics ?? {}), [
      "kd_ratio", "win_rate", "kills_per_match", "damage_per_match",
    ]);
    assert.equal(damageTeamFight?.metrics.kd_ratio.reason, "zero_std");
    assert.equal(damageTeamFight?.metrics.win_rate.reason, "zero_std");
    assert.equal(damageTeamFight?.metrics.kills_per_match.reason, "zero_std");
    assert.equal(damageTeamFight?.metrics.damage_per_match.z, z);
    assert.equal(damageTeamFight?.metrics.damage_per_match.points, points);
    assert.equal(damageTeamFight?.score, Math.round(Math.max(...Object.values(damageTeamFight!.metrics)
      .map((metric) => metric.points ?? Number.NEGATIVE_INFINITY))));
    assert.equal(damageOnly?.score, damageOnly?.overall.score);
  }
});

test("Arena risk uses the population when matched LastHero peers are sparse or hours are missing", async () => {
  resetArenaData();
  const aid = 1_400_198;
  const target = profile(aid, { games: 725, hours: 1_430, kills: 56, deaths: 33 });
  const lastHero = target.stat.arenaOverAllCounters.UnrankedLastHero.Counters;
  lastHero.GamesCount = 725;
  lastHero.Kills = 40_600;
  lastHero.Deaths = 24_200;
  lastHero.DamageDealt = 10_295_000;
  await save(target);
  for (let offset = 1; offset <= 34; offset += 1) {
    const matched = offset <= 16;
    await save(profile(aid + offset, {
      games: matched ? 725 : 20,
      hours: matched ? 1_430 : 100,
      kills: 20 + offset % 4,
      deaths: 20,
    }));
  }

  const cohort = await getArenaCohort(aid, "lastHero");
  assert.equal(cohort?.quality, "unavailable");
  assert.equal(cohort?.reason, "insufficient_cohort");
  assert.equal(cohort?.sampleN, 16);

  let risk = await getArenaProfileRisk(aid);
  let lastHeroRisk = risk?.modes.find((mode) => mode.mode === "lastHero");
  assert.equal(lastHeroRisk?.peerCount, 34);
  assert.ok((lastHeroRisk?.score ?? 0) > 0);
  assert.equal(risk?.version.calculation, 3);

  const db = new DatabaseSync(process.env.SQLITE_PATH);
  try {
    db.prepare("UPDATE arena_mode_stats SET hours = NULL WHERE aid = ? AND arena_mode = 'lastHero'").run(aid);
  } finally {
    db.close();
  }
  risk = await getArenaProfileRisk(aid);
  lastHeroRisk = risk?.modes.find((mode) => mode.mode === "lastHero");
  assert.equal(lastHeroRisk?.peerCount, 34);
  assert.ok((lastHeroRisk?.score ?? 0) > 0);
});

test("Arena batched risk recompute matches pre-batch results across modes", async () => {
  resetArenaData();
  await save(profile(900, { kills: 120, deaths: 8 }));
  for (let aid = 901; aid <= 930; aid += 1) await save(profile(aid, { kills: 20 + (aid % 4), deaths: 20 }));
  const first = await getArenaProfileRisk(900);
  assert.ok(first);
  assert.equal(first.score, first.overall.score);
  assert.ok((first.score ?? 0) > 0);
  assert.equal(first.tier, first.score < 20 ? "low" : first.score < 45 ? "medium" : first.score < 70 ? "high" : "severe");
  assert.equal(first.overall.peerCount, 30);
  assert.equal(first.modes.length, 5);
  for (const modeRisk of first.modes) {
    assert.deepEqual(Object.keys(modeRisk.metrics), [
      "kd_ratio", "win_rate", "kills_per_match", "damage_per_match",
    ]);
    assert.equal(modeRisk.peerCount, 30);
  }
  const teamFight = first.modes.find((mode) => mode.mode === "teamFight");
  assert.equal(teamFight.percent, 10);
  assert.ok(teamFight.reasons.some((reason) => reason.startsWith("high_")));
  const normalize = (risk) => ({ ...risk, freshness: { ...risk.freshness, evaluatedAt: 0 } });
  const second = await getArenaProfileRisk(900);
  assert.deepEqual(normalize(second), normalize(first));

  const missingDb = new DatabaseSync(process.env.SQLITE_PATH);
  try {
    missingDb.prepare("DELETE FROM arena_mode_stats WHERE aid = ? AND arena_mode = ?").run(900, "teamFight");
  } finally {
    missingDb.close();
  }
  const missingMode = await getArenaProfileRisk(900);
  const missingTeamFight = missingMode?.modes.find((mode) => mode.mode === "teamFight");
  assert.equal(missingTeamFight?.score, null);
  assert.equal(missingTeamFight?.peerCount, 0);
  assert.ok(missingTeamFight?.reasons.includes("target_unavailable"));

  assert.equal(await getArenaProfileRisk(999999), null);

  resetArenaData();
  await save(profile(950, { games: 1 }));
  const belowMinimum = await getArenaProfileRisk(950);
  assert.equal(belowMinimum?.score, null);
  assert.ok(belowMinimum?.overall.reasons.includes("target_below_minimum_matches"));
  for (const modeRisk of belowMinimum?.modes ?? []) {
    assert.ok(modeRisk.reasons.includes("target_below_minimum_matches"));
    assert.equal(modeRisk.peerCount, 0);
  }

  await save(profile(951));
  const staleDb = new DatabaseSync(process.env.SQLITE_PATH);
  try {
    staleDb.prepare("UPDATE arena_mode_stats SET parser_version = 0 WHERE aid = 951").run();
  } finally {
    staleDb.close();
  }
  assert.equal(await getArenaProfileRisk(951), null);
});

test("Arena risk streams selected numeric peers through a covering index", async () => {
  resetArenaData();
  await save(profile(900, { kills: 120, deaths: 8 }));
  for (let aid = 901; aid <= 930; aid += 1) await save(profile(aid, { kills: 20 + (aid % 4), deaths: 20 }));
  const { getArenaBackend } = await import("../lib/db.ts");
  const backend = await getArenaBackend();
  assert.equal(backend.kind, "sqlite");
  const prepare = backend.db.prepare;
  const buffered = [];
  const streamed = [];
  backend.db.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    if (/FROM arena_mode_stats/.test(sql) && /^\s*SELECT/i.test(sql)) {
      const all = statement.all;
      statement.all = function (...args) {
        const rows = all.apply(this, args);
        buffered.push(rows.length);
        return rows;
      };
      const iterate = statement.iterate;
      statement.iterate = function* (...args) {
        const plan = prepare.call(backend.db, `EXPLAIN QUERY PLAN ${sql}`).all(...args);
        assert.match(plan.map((row) => row.detail).join("\n"), /COVERING INDEX idx_arena_mode_stats_comparison/);
        assert.doesNotMatch(sql, /raw_json|headshot_rate|upstream_version|fetched_at/);
        for (const row of iterate.apply(this, args)) {
          streamed.push(row);
          yield row;
        }
      };
    }
    return statement;
  };
  try {
    const risk = await getArenaProfileRisk(900);
    assert.equal(risk?.overall.peerCount, 30);
    assert.deepEqual(buffered, [6, 5]); // Targets and range counts, never peer objects.
    assert.equal(streamed.length, 5 * 30);
    assert.equal(streamed[0].length, 5); // Mode plus four numeric metrics.
  } finally {
    backend.db.prepare = prepare;
  }
});

test("Arena indexed selection matches reference filtering and formulas across modes and boundaries", async () => {
  resetArenaData();
  const { getArenaBackend } = await import("../lib/db.ts");
  const { db } = await getArenaBackend();
  const modes = ["overall", "teamFight", "lastHero", "checkpoint", "blastGang", "shootOutDuo"];
  const metrics = ["kd_ratio", "win_rate", "headshot_rate", "kills_per_match", "damage_per_match"];
  const insert = db.prepare(`INSERT INTO arena_mode_stats
    (aid, arena_mode, hours, games_count, kd_ratio, win_rate, headshot_rate, kills_per_match,
     damage_per_match, upstream_version, parser_version, raw_json, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1800000000000, ?, '{}', 1800000000000)`);
  db.exec("BEGIN");
  for (let aid = 1; aid <= 301; aid++) {
    for (const [modeIndex, mode] of modes.entries()) {
      const hours = [70, 80, 85, 90, 95, 100, 105, 110, 115, 120, 130][(aid + modeIndex) % 11];
      insert.run(aid, mode, hours, 80 + ((aid * 7 + modeIndex * 3) % 41),
        aid % 13 ? ((aid * 7) % 40) / 10 : null, aid % 17 ? (aid % 100) : null,
        aid % 19 ? (aid % 80) : null, 0.1, 1e9 + (aid % 3) / 100,
        aid % 31 ? ARENA_PARSER_VERSION : 0);
    }
  }
  db.exec(`INSERT INTO excluded_players VALUES (13, 'test', 1), (20, 'test', 1);
    UPDATE arena_mode_stats SET hours = NULL WHERE aid = 7 AND arena_mode = 'lastHero';
    UPDATE arena_mode_stats SET games_count = 9 WHERE aid = 8 AND arena_mode = 'checkpoint';
    UPDATE arena_mode_stats SET kd_ratio = 'invalid', damage_per_match = NULL WHERE aid = 9;
    UPDATE arena_mode_stats SET hours = 0, games_count = 10 WHERE aid = 10;
    COMMIT`);
  // Preserve index traversal order when comparing floating-point reductions.
  const rows = db.prepare("SELECT * FROM arena_mode_stats ORDER BY arena_mode, games_count, hours, aid").all();
  const valid = (value) => typeof value === "number" && Number.isFinite(value);
  const sameNumber = (actual, expected, label = "") => {
    if (expected === null) assert.equal(actual, null);
    else assert.ok(Math.abs(actual - expected) <= 1e-8 * Math.max(1, Math.abs(expected)), `${label}${actual} != ${expected}`);
  };
  const meanOf = (values) => {
    const anchor = values.reduce((minimum, value) => Math.min(minimum, value), Number.POSITIVE_INFINITY);
    return anchor + values.reduce((sum, value) => sum + (value - anchor), 0) / values.length;
  };
  const eligiblePeersFor = (target) => rows.filter((row) => row.arena_mode === target.arena_mode && row.aid !== target.aid &&
    ![13, 20].includes(row.aid) && row.parser_version === ARENA_PARSER_VERSION && row.games_count >= 10);
  const peersFor = (target, minimum) => {
    const eligible = eligiblePeersFor(target);
    if (target.arena_mode === "overall") return { peers: eligible, percent: 30 };
    for (const percent of [10, 15, 20, 30]) {
      const peers = eligible.filter((row) => valid(row.hours) && valid(row.games_count) &&
        row.hours >= Math.max(0, target.hours * (1 - percent / 100)) && row.hours <= target.hours * (1 + percent / 100) &&
        row.games_count >= Math.max(0, target.games_count * (1 - percent / 100)) && row.games_count <= target.games_count * (1 + percent / 100));
      if (peers.length >= minimum || percent === 30) return { peers, percent };
    }
  };
  const riskPeersFor = (target) => {
    const eligible = eligiblePeersFor(target);
    if (target.arena_mode === "overall" || !valid(target.hours)) return { peers: eligible, percent: 30 };
    for (const percent of [10, 15, 20, 30]) {
      const peers = eligible.filter((row) => valid(row.hours) && valid(row.games_count) &&
        row.hours >= Math.max(0, target.hours * (1 - percent / 100)) && row.hours <= target.hours * (1 + percent / 100) &&
        row.games_count >= Math.max(0, target.games_count * (1 - percent / 100)) && row.games_count <= target.games_count * (1 + percent / 100));
      if (peers.length >= 30) return { peers, percent };
    }
    return { peers: eligible, percent: 30 };
  };
  for (const aid of [1, 2, 3, 7, 8, 9, 10, 13, 20, 31]) {
    const risk = await getArenaProfileRisk(aid);
    if ([13, 20, 31].includes(aid)) {
      assert.equal(risk, null);
      continue;
    }
    for (const mode of modes) {
      const target = rows.find((row) => row.aid === aid && row.arena_mode === mode);
      const targetAvailable = target.games_count >= 10 && (mode === "overall" || valid(target.hours));
      for (const kind of ["trimmed_mean", "median"]) {
        const cohort = await getArenaCohort(aid, mode, kind);
        if (!targetAvailable) { assert.equal(cohort.reason, "target_unavailable"); continue; }
        const { peers, percent } = peersFor(target, 20);
        assert.equal(cohort.sampleN, peers.length);
        assert.equal(cohort.percent, percent);
        assert.equal(cohort.quality, peers.length >= 20 ? "sufficient" : "unavailable");
        for (const metric of metrics) {
          if (mode !== "overall" && peers.length < 20) {
            assert.equal(cohort.metrics[metric].count, 0);
            continue;
          }
          const values = peers.map((row) => row[metric]).filter(valid).sort((a, b) => a - b);
          assert.equal(cohort.metrics[metric].count, values.length);
          const trim = Math.floor(values.length * 0.05);
          const kept = values.slice(trim, values.length - trim);
          const expected = values.length < 20 ? null : kind === "median"
            ? (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2
            : kept.reduce((sum, v) => sum + v, 0) / kept.length;
          sameNumber(cohort.metrics[metric].value, expected);
        }
      }
      const actualRisk = mode === "overall" ? risk.overall : risk.modes.find((entry) => entry.mode === mode);
      if (target.games_count < 10) { assert.equal(actualRisk.score, null); assert.equal(actualRisk.peerCount, 0); continue; }
      const { peers, percent } = riskPeersFor(target);
      assert.equal(actualRisk.peerCount, peers.length);
      if (mode !== "overall") assert.equal(actualRisk.percent, percent);
      const points = [];
      for (const metric of metrics.filter((key) => key !== "headshot_rate")) {
        const values = peers.map((row) => row[metric]).filter(valid);
        const actual = actualRisk.metrics[metric];
        assert.equal(actual.count, values.length);
        if (!valid(target[metric])) { assert.equal(actual.reason, "missing_metric"); continue; }
        if (values.length < 30) { assert.equal(actual.reason, "insufficient_peers"); continue; }
        const mean = meanOf(values);
        const variance = values.every((v) => v === values[0]) ? 0 : Math.max(0, values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length);
        const std = Math.sqrt(variance);
        sameNumber(actual.mean, mean);
        sameNumber(actual.std, std);
        if (std === 0) { assert.equal(actual.reason, "zero_std"); continue; }
        const z = (target[metric] - mean) / std;
        const score = 100 * Math.max(0, Math.min(1, (z - 2) / 4));
        sameNumber(actual.z, z, `${aid}:${mode}:${metric}: `);
        sameNumber(actual.points, score);
        points.push(score);
      }
      assert.equal(actualRisk.score, points.length ? Math.round(Math.max(...points)) : null);
    }
  }
});

test("Arena numeric scans preserve object-row SQLite and D1 results and D1 bind limits", async () => {
  resetArenaData();
  await save(profile(900, { kills: 120, deaths: 8 }));
  for (let aid = 901; aid <= 930; aid++) await save(profile(aid, { kills: 20 + aid % 4 }));
  const { getArenaBackend } = await import("../lib/db.ts");
  const { db } = await getArenaBackend();
  const normalize = (risk) => ({ ...risk, freshness: { ...risk.freshness, evaluatedAt: 0 } });
  const expectedRisk = normalize(await getArenaProfileRisk(900));
  const expectedCohort = await getArenaCohort(900, "teamFight");
  const prepare = db.prepare;
  db.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    statement.setReturnArrays = undefined;
    return statement;
  };
  try {
    assert.deepEqual(normalize(await getArenaProfileRisk(900)), expectedRisk);
    assert.deepEqual(await getArenaCohort(900, "teamFight"), expectedCohort);
  } finally {
    db.prepare = prepare;
  }
  const key = Symbol.for("__cloudflare-context__");
  const previous = globalThis[key];
  const parameterCounts = [];
  globalThis[key] = { env: { DB: {
    prepare(sql) {
      const statement = db.prepare(sql);
      return { bind(...params) {
        parameterCounts.push(params.length);
        assert.ok(params.length <= 100, "D1 parameter limit");
        return { all: async () => ({ results: statement.all(...params) }),
          run: async () => statement.run(...params) };
      } };
    },
  } } };
  try {
    assert.equal((await getArenaBackend()).kind, "d1");
    assert.deepEqual(normalize(await getArenaProfileRisk(900)), expectedRisk);
    assert.deepEqual(await getArenaCohort(900, "teamFight"), expectedCohort);
    assert.ok(parameterCounts.length >= 7);
  } finally {
    if (previous === undefined) delete globalThis[key];
    else globalThis[key] = previous;
  }
});

test("Arena parser version gates analytics, equal-version parser upgrades win, and SQLite rolls back the legacy envelope", async () => {
  resetArenaData();
  const db = new DatabaseSync(process.env.SQLITE_PATH);
  try {
    const old = parseArenaProfileStats(profile(400)).arenaProfile;
    old.parserVersion = 0;
    upsertArenaSqlite(db, old, 1);
    const oldAverage = await getArenaAverage({ mode: "teamFight" });
    assert.equal(oldAverage?.sampleN, 0);
    const upgraded = parseArenaProfileStats(profile(400)).arenaProfile;
    upgraded.parserVersion = 1;
    upsertArenaSqlite(db, upgraded, 2);
    assert.equal(db.prepare("SELECT parser_version FROM arena_mode_stats WHERE aid = 400 AND arena_mode = 'teamFight'").get().parser_version, 1);
    const prepared = [];
    const statements = arenaUpsertStatements({ prepare(sql) { return { bind(...values) { prepared.push({ sql, values }); return { sql, values }; } }; } }, upgraded, 3);
    assert.equal(statements.length, 12);
    assert.equal(prepared.length, 12);
    assert.match(ARENA_UPSERT_SQL, /excluded\.parser_version >= arena_mode_stats\.parser_version/);
    assert.match(ARENA_HISTORY_INSERT_SQL, /INSERT OR IGNORE INTO arena_mode_stats_history/);
    upgraded.parserVersion = 0;
    upsertArenaSqlite(db, upgraded, 3);
    assert.equal(db.prepare("SELECT parser_version FROM arena_mode_stats WHERE aid = 400 AND arena_mode = 'teamFight'").get().parser_version, 1);
    db.exec(`CREATE TRIGGER arena_fixture_failure BEFORE INSERT ON arena_mode_stats
      WHEN NEW.arena_mode = 'lastHero' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;`);
  } finally {
    db.close();
  }
  const store = await getStore("arena");
  assert.ok(store);
  await assert.rejects(store.upsert(401, parseArenaProfileStats(profile(401)), []), /fixture failure/);
  const check = new DatabaseSync(process.env.SQLITE_PATH);
  try {
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM arena_mode_stats WHERE aid = 401").get().n, 0);
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM arena_mode_stats_history WHERE aid = 401").get().n, 0);
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM mode_players WHERE mode = 'arena' AND aid = 401").get().n, 0);
  } finally {
    check.close();
  }
});
