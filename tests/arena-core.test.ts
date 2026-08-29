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

const directory = mkdtempSync(join(tmpdir(), "tarkov-arena-core-"));
process.env.SQLITE_PATH = join(directory, "players.db");
process.env.BANS_SQLITE_PATH = join(directory, "bans.db");

const { getStore } = await import("../lib/db.ts");
const { parseArenaProfileStats } = await import("../lib/tarkov-api.ts");
const { getArenaAverage, getArenaCohort, getArenaProfile, getArenaProfileRisk } = await import("../lib/arena/service.ts");
const { ARENA_UPSERT_SQL, arenaUpsertStatements, upsertArenaSqlite } = await import("../lib/arena/storage.ts");

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
    db.exec("DROP TRIGGER IF EXISTS arena_fixture_failure; DELETE FROM arena_risk_evaluations; DELETE FROM arena_mode_stats; DELETE FROM mode_players WHERE mode = 'arena'; DELETE FROM excluded_players");
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
  assert.equal(arena.modes.shootOutDuo.counters.matches, null);
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

test("Arena overall falls back only to complete five-mode additive totals and maxima", () => {
  const source = profile(511);
  for (const [index, name] of modeNames.entries()) {
    const counters = source.stat.arenaOverAllCounters[name].Counters;
    counters.Kills = 10 + index;
    counters.MaxKillsWithoutDeaths = 20 + index;
  }
  source.stat.arenaOverAllCounters.UnrankedOverall = { Counters: { GamesCount: 100 } };
  const complete = parseArenaProfileStats(source).arenaProfile.overall;
  assert.equal(complete.source, "upstream");
  assert.equal(complete.counters.kills, 60);
  assert.equal(complete.counters.max_kill_streak, 24);
  assert.equal(complete.counters.current_kill_streak, null);

  delete source.stat.arenaOverAllCounters.UnrankedShootOutDuo.Counters.DamageDealt;
  const partial = parseArenaProfileStats(source).arenaProfile.overall;
  assert.equal(partial.counters.damage, null);
  assert.equal(partial.metrics.damage_per_match, null);
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
    const raw = JSON.parse(db.prepare("SELECT raw_json FROM arena_mode_stats WHERE aid = 502 AND arena_mode = 'teamFight'").get().raw_json);
    assert.equal(raw.sourceCounters.Counters.FutureCounter, 17);
  } finally {
    db.close();
  }
  const normalized = await getArenaProfile(502);
  assert.equal(normalized?.modes.teamFight.counters.headshots, null);
});

test("Arena averages, cohort, and display-only risk use current eligible snapshots", async () => {
  const store = await getStore("arena");
  assert.ok(store);
  const reset = new DatabaseSync(process.env.SQLITE_PATH);
  try {
    reset.exec("DELETE FROM arena_risk_evaluations; DELETE FROM arena_mode_stats; DELETE FROM mode_players WHERE mode = 'arena'");
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
    assert.equal(saved.version.calculation, 2);
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
    assert.equal(statements.length, 6);
    assert.equal(prepared.length, 6);
    assert.match(ARENA_UPSERT_SQL, /excluded\.parser_version >= arena_mode_stats\.parser_version/);
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
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM mode_players WHERE mode = 'arena' AND aid = 401").get().n, 0);
  } finally {
    check.close();
  }
});
