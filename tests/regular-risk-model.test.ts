/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- direct Node TypeScript tests use explicit extension imports.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { buildRegularRiskBaseline, scoreRegularCheater, regularHoursMultiplier, validatedRegularRiskInputs, storedRegularRiskInputs } from "../lib/regular-risk-score.ts";
import { backfillRegularRiskReferences } from "../lib/regular-risk-reference-backfill.ts";
import { materializeDueAchievementBaselines } from "../scripts/materialize-progression-population.mjs";
import { materializeAchievementBaseline, readRegularRiskAchievementBaseline } from "../lib/achievement-baseline-publication.ts";
import { ADMIN_RISK_SCORE_VERSIONS } from "../lib/admin/risk-version.ts";

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
  return nextResolve(specifier, context);
} });
const directory = mkdtempSync(join(tmpdir(), "regular-risk-"));
for (const [key, name] of [["SQLITE_PATH", "players"], ["BANS_SQLITE_PATH", "bans"], ["ADMIN_ANALYTICS_SQLITE_PATH", "admin"], ["PROGRESSION_SQLITE_PATH", "progression"], ["REPORTS_SQLITE_PATH", "reports"]]) process.env[key] = join(directory, `${name}.db`);
const { getStore } = await import("../lib/db.ts");
const { parseProfileStats, PVP_STATS_PARSER_VERSION } = await import("../lib/tarkov-api.ts");
const { evaluateAndStoreRisk } = await import("../lib/admin/risk-service.ts");
const { getRiskEvaluation, saveRiskEvaluation } = await import("../lib/admin/moderation-db.ts");
const raw = (overrides = {}) => ({ raids: 1000, deaths: 100, survived: 800, kills: 900, killedPmc: 600, streak: 5, prestige: 0, ...overrides });
const stats = (overrides = {}, hours = 100) => ({ hoursPlayed: hours, pmcRaids: overrides.raids ?? 1000, regularRiskInputs: raw(overrides) });
const peers = (overrides = {}, hours = 100, n = 40) => Array.from({ length: n }, (_, i) => ({ aid: i + 1, hours, raw: raw(overrides) }));
const base = (rows = peers()) => buildRegularRiskBaseline(rows, { hours: 100, pmcRaids: 1000 }, 999);
const factor = (result, key) => result.factors.find((f) => f.key === key);

test("saved legacy counters recover evidence without inventing missing zeroes or total PMC kills", () => {
  const legacy = { pmcRaids: 1000, pmcDeaths: 0, pmcSurvived: 0, pmcKills: 900, killedPmc: 600,
    pmcKilledPmc: 0, longestWinStreak: 0, prestige: 0 };
  assert.deepEqual(storedRegularRiskInputs(legacy), {
    raids: 1000, deaths: null, survived: null, kills: 900, killedPmc: null, streak: null, prestige: null,
  });
  const exact = storedRegularRiskInputs({ ...legacy, pvpStatsVersion: 1, pvpStatsKnown: true });
  assert.equal(exact.deaths, 0);
  assert.equal(exact.killedPmc, 0);
  assert.equal(exact.survived, null);
  assert.equal(storedRegularRiskInputs({ ...legacy, pvpStatsKnown: false, pmcKilledPmc: 600 }).killedPmc, null);
  assert.equal(storedRegularRiskInputs({ ...legacy, regularRiskInputs: raw({ kills: null }) }).kills, null);
});

test("existing profile population supplies matched risk without upstream refresh or overwriting newer inputs", () => {
  const players = new DatabaseSync(":memory:");
  const snapshots = new DatabaseSync(":memory:");
  try {
    players.exec(`CREATE TABLE players(aid INTEGER PRIMARY KEY, hours REAL, pmc_raids INTEGER,
      profile_updated_at INTEGER, risk_raids INTEGER, risk_deaths INTEGER, risk_survived INTEGER,
      risk_kills INTEGER, risk_killed_pmc INTEGER, risk_streak INTEGER, risk_prestige INTEGER, risk_parser_version INTEGER);
      CREATE TABLE excluded_players(aid INTEGER PRIMARY KEY);`);
    snapshots.exec(`CREATE TABLE progression_snapshots(id INTEGER PRIMARY KEY, mode TEXT, cycle_id TEXT,
      aid INTEGER, upstream_updated_at INTEGER, captured_at INTEGER, stats_json TEXT);`);
    const player = players.prepare("INSERT INTO players(aid, hours, pmc_raids, profile_updated_at) VALUES (?, 6482.4, 2817, 1000)");
    const snapshot = snapshots.prepare("INSERT INTO progression_snapshots(mode, cycle_id, aid, upstream_updated_at, captured_at, stats_json) VALUES (?, 'persistent', ?, 1000, 1000, ?)");
    for (let aid = 1; aid <= 45; aid++) {
      player.run(aid);
      snapshot.run("regular", aid, JSON.stringify({ profileUpdatedAt: 1000, pmcRaids: 2817, pmcDeaths: 1414,
        pmcSurvived: 922, pmcKills: 11195, pmcKilledPmc: 2214, longestWinStreak: 14, prestige: 6,
        pvpStatsVersion: 1, pvpStatsKnown: true, pvpStatsParserVersion: 1 }));
    }
    players.exec("INSERT INTO excluded_players VALUES (1); UPDATE players SET risk_parser_version=2, risk_raids=2817, risk_kills=10 WHERE aid=2; UPDATE players SET risk_parser_version=1 WHERE aid=6");
    snapshots.exec("UPDATE progression_snapshots SET mode='pve' WHERE aid=3; UPDATE progression_snapshots SET upstream_updated_at=999 WHERE aid=4; UPDATE progression_snapshots SET stats_json='broken' WHERE aid=5");
    assert.equal(backfillRegularRiskReferences(players, snapshots), 40);
    assert.equal(backfillRegularRiskReferences(players, snapshots), 0);
    assert.equal(players.prepare("SELECT risk_kills FROM players WHERE aid=2").get().risk_kills, 10);
    assert.equal(players.prepare("SELECT risk_raids FROM players WHERE aid=4").get().risk_raids, null);
    const recovered = players.prepare("SELECT * FROM players WHERE risk_parser_version=1").all().map((row) => ({ aid: row.aid, hours: row.hours,
      raw: { raids: row.risk_raids, deaths: row.risk_deaths, survived: row.risk_survived, kills: row.risk_kills,
        killedPmc: row.risk_killed_pmc, streak: row.risk_streak, prestige: row.risk_prestige } }));
    const baseline = buildRegularRiskBaseline(recovered, { hours: 6482.4, pmcRaids: 2817 }, 5869253);
    const result = scoreRegularCheater(stats({ raids: 2817, deaths: 1414, survived: 922, kills: 11195, killedPmc: 2214 }, 6482.4), baseline);
    assert.equal(result.availability, "available");
    assert.equal(factor(result, "pmc_kd_ratio").cohortN, 40);
  } finally { players.close(); snapshots.close(); }
});

test("a recent legacy publication still initializes all achievement owner references", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE players(aid INTEGER PRIMARY KEY, hours REAL, achievements TEXT);
      CREATE TABLE mode_players(mode TEXT, aid INTEGER, hours REAL, achievements TEXT);
      CREATE TABLE excluded_players(aid INTEGER PRIMARY KEY);`);
    const insert = db.prepare("INSERT INTO players VALUES (?, 1000, ?)");
    for (let aid = 1; aid <= 40; aid++) insert.run(aid, JSON.stringify([ultra]));
    materializeAchievementBaseline(db, "regular", 1000);
    materializeAchievementBaseline(db, "pve", 1000);
    db.exec("DELETE FROM regular_risk_reference_state; DELETE FROM regular_risk_achievement_owners");
    const restored = materializeDueAchievementBaselines(db, { now: 1001 });
    assert.deepEqual(restored.errors, []);
    assert.deepEqual(restored.published, []);
    assert.equal(readRegularRiskAchievementBaseline(db, [ultra], 999).achievements[0].hoursOwners, 40);
    assert.equal(materializeDueAchievementBaselines(db, { now: 1002 }).published.length, 0);
  } finally { db.close(); }
});

test("the same exact K/D changes risk when nearby hours AND raid peers change", () => {
  const target = stats();
  const weaker = scoreRegularCheater(target, base(peers({ killedPmc: 100, kills: 150 })));
  const stronger = scoreRegularCheater(target, base(peers({ killedPmc: 900, kills: 1200 })));
  assert.ok(factor(weaker, "pmc_kd_ratio").evidencePoints > 50);
  assert.equal(factor(stronger, "pmc_kd_ratio").evidencePoints, 0);
  assert.ok(weaker.score > stronger.score);
  const outside = [...peers({}, 200), ...peers({ raids: 2000 }, 100)];
  assert.equal(scoreRegularCheater(target, base(outside)).availability, "unavailable");
});

test("each metric expands through its own populated window and valid zeros count", () => {
  const rows = peers({ killedPmc: null, kills: 0 }, 100, 40);
  rows.push(...peers({ killedPmc: 0, kills: 0 }, 114, 30).map((p) => ({ ...p, aid: p.aid + 100 })));
  const baseline = base(rows);
  assert.equal(baseline.metrics.pmc_kd_ratio.percent, 15);
  assert.equal(baseline.metrics.pmc_kd_ratio.n, 30);
  assert.equal(baseline.metrics.pmc_kills_per_raid.percent, 10);
  const result = scoreRegularCheater(stats({ killedPmc: 0, kills: 0 }), baseline);
  assert.equal(factor(result, "pmc_kd_ratio").available, true);
  assert.equal(factor(result, "pmc_kd_ratio").value, 0);
  assert.equal(result.score, 0);
});

test("missing exact PvP counters keep survival and general PMC combat available", () => {
  const baseline = base(peers({ killedPmc: null, kills: 100 }));
  const result = scoreRegularCheater(stats({ killedPmc: null }), baseline);
  assert.equal(result.availability, "partial");
  assert.equal(factor(result, "pmc_kd_ratio").available, false);
  assert.equal(factor(result, "pmc_survival_rate").available, true);
  assert.equal(factor(result, "pmc_all_kd_ratio").available, true);
  assert.ok(result.score > 0);
});

test("no evidence and sparse references remain unavailable; flat zeros do not amplify tiny counts", () => {
  assert.equal(scoreRegularCheater({ hoursPlayed: 100 }, null).availability, "unavailable");
  assert.equal(scoreRegularCheater(stats(), base(peers({}, 100, 29))).availability, "unavailable");
  const result = scoreRegularCheater(stats({ killedPmc: 1, kills: 1 }), base(peers({ killedPmc: 0, kills: 0 })));
  assert.equal(factor(result, "killed_pmc_per_raid").available, true);
  assert.ok(factor(result, "killed_pmc_per_raid").evidencePoints < 1);
  assert.ok(Number.isFinite(result.score));
});

test("tuple corruption is missing evidence rather than a maximum-risk signal", () => {
  assert.equal(validatedRegularRiskInputs(raw({ deaths: 1001 })).deaths, null);
  const incompatible = validatedRegularRiskInputs(raw({ survived: 950 }));
  assert.equal(incompatible.survived, null);
  assert.equal(incompatible.deaths, null);
  const overflow = validatedRegularRiskInputs(raw({ raids: 1, deaths: 0, survived: 1, kills: 2_100_000_000, killedPmc: 2_100_000_000 }));
  assert.equal(overflow.kills, null);
  assert.equal(overflow.killedPmc, null);
  assert.equal(validatedRegularRiskInputs(raw({ killedPmc: 901 })).killedPmc, null);
  assert.equal(validatedRegularRiskInputs(raw({ kills: -1 })).kills, null);
});

test("twenty representative raids shrink low-raid survival and keep zero-death KD finite", () => {
  const rows = peers({ raids: 1, deaths: 0, survived: 1, kills: 1, killedPmc: 1, streak: 1 });
  const baseline = buildRegularRiskBaseline(rows, { hours: 100, pmcRaids: 1 }, 999);
  const result = scoreRegularCheater(stats({ raids: 1, deaths: 0, survived: 1, kills: 5, killedPmc: 5, streak: 1 }), baseline);
  assert.ok(Number.isFinite(factor(result, "pmc_kd_ratio").value));
  assert.ok(factor(result, "killed_pmc_per_raid").value < 1.2);
  assert.equal(factor(result, "pmc_survival_rate").value, 100);
});

test("hours multiply supported evidence monotonically, with a continuous 1000-hour boundary", () => {
  assert.equal(regularHoursMultiplier(100), 2.8);
  assert.equal(regularHoursMultiplier(500), 2);
  assert.equal(regularHoursMultiplier(1000), 1);
  assert.equal(regularHoursMultiplier(4000), 1);
  assert.ok(Math.abs(regularHoursMultiplier(999.99) - 1) < 0.0001);
  const baseline = base(peers({ killedPmc: 100, kills: 150 }));
  assert.ok(scoreRegularCheater(stats({}, 100), baseline).score >= scoreRegularCheater(stats({}, 500), baseline).score);
  assert.ok(scoreRegularCheater(stats({}, 500), baseline).score >= scoreRegularCheater(stats({}, 1000), baseline).score);
  assert.equal(scoreRegularCheater(stats({}, 1000), base()).score, 0);
});

const ultra = "6514143d59647d2cb3213c93";
const oldKappa = "664f1f8768508d74604bf556";
const newKappa = "6a60f75f1a1222ee000baf0d";
const achievement = (id, overrides = {}) => ({ id, owners: 40, hoursOwners: 40, samplePct: 5, meanHours: 2000, earlyHours: 1000, ...overrides });

test("unknown achievement prevalence is not assumed rare; critical owner evidence stands alone", () => {
  const unknown = (id) => ({ ownedIds: [id], stats: [achievement(id, { samplePct: Number.NaN })] });
  const ordinary = scoreRegularCheater({ hoursPlayed: 100 }, null, unknown("ordinary-achievement"));
  assert.equal(ordinary.availability, "unavailable");
  assert.equal(ordinary.score, 0);
  assert.equal(scoreRegularCheater({ hoursPlayed: 100 }, null, unknown(ultra)).score, 85);
});

test("100-hour Ultra and Kappa can independently drive severe risk from observed owners", () => {
  for (const id of [ultra, oldKappa, newKappa]) {
    const result = scoreRegularCheater({ hoursPlayed: 100 }, null, { ownedIds: [id], stats: [achievement(id)] });
    assert.equal(result.tier, "severe");
    assert.equal(result.score, 85);
    assert.equal(factor(result, "ach_early").ownerHoursP20, 1000);
  }
  const unreliable = scoreRegularCheater({ hoursPlayed: 100 }, null, { ownedIds: [ultra], stats: [achievement(ultra, { hoursOwners: 29 })] });
  assert.equal(unreliable.availability, "unavailable");
  const absentTrust = scoreRegularCheater({ hoursPlayed: 100 }, null, { ownedIds: [ultra], stats: [achievement(ultra, { hoursOwners: undefined })] });
  assert.equal(absentTrust.availability, "unavailable");
});

test("Kappa aliases never get duplicate credit; events are excluded; capped accounting sums", () => {
  const achievementInput = { ownedIds: [ultra, oldKappa, newKappa, "660fe21454670811e304c045"], stats: [ultra, oldKappa, newKappa, "660fe21454670811e304c045"].map((id) => achievement(id)) };
  const result = scoreRegularCheater(stats({ survived: 900, deaths: 1, streak: 100, killedPmc: 900 }), base(peers({ killedPmc: 10, kills: 100, survived: 500, deaths: 500 })), achievementInput);
  assert.equal(result.factors.filter((f) => f.achievementId === oldKappa || f.achievementId === newKappa).length, 1);
  assert.equal(result.factors.some((f) => f.achievementId === "660fe21454670811e304c045"), false);
  assert.ok(result.score <= 100);
  assert.equal(result.factors.reduce((sum, f) => sum + f.points, 0), result.score);
  assert.ok(factor(result, "compound_anomaly").points <= 15);
  assert.ok(result.factors.filter((f) => f.group === "combat" && f.points > 0).length <= 1);
  assert.deepEqual(ADMIN_RISK_SCORE_VERSIONS, { regular: 3, pve: 2, seasonal: 2, arena: 1 });
});

test("survival and KD cannot corroborate the same low-death evidence", () => {
  const baseline = base(peers({ deaths: 500, survived: 500, kills: 2000, killedPmc: 500 }));
  const result = scoreRegularCheater(stats({ deaths: 10, survived: 990, kills: 2000, killedPmc: 500 }), baseline);
  assert.equal(factor(result, "compound_anomaly").points, 0);
  assert.equal(factor(result, "killed_pmc_per_raid").evidencePoints, 0);
  assert.equal(factor(result, "pmc_kills_per_raid").evidencePoints, 0);
});

test("indexed owner references exclude the target, tombstones, missing hours and duplicate aliases", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE players(aid INTEGER PRIMARY KEY, hours REAL, achievements TEXT); CREATE TABLE mode_players(mode TEXT, aid INTEGER, hours REAL, achievements TEXT); CREATE TABLE excluded_players(aid INTEGER PRIMARY KEY)");
  const insert = db.prepare("INSERT INTO players VALUES (?, ?, ?)");
  for (let aid = 1; aid <= 30; aid++) insert.run(aid, aid === 1 ? 100 : 1000 + aid, JSON.stringify([ultra, ultra]));
  insert.run(31, 0, JSON.stringify([ultra]));
  insert.run(32, 1000, JSON.stringify([ultra]));
  db.prepare("INSERT INTO excluded_players VALUES (32)").run();
  materializeAchievementBaseline(db, "regular");
  const baseline = readRegularRiskAchievementBaseline(db, [ultra], 1);
  assert.equal(baseline.achievements[0].hoursOwners, 29);
  assert.ok(baseline.achievements[0].earlyHours > 1000);
  const result = scoreRegularCheater({ hoursPlayed: 100 }, null, { ownedIds: [ultra], stats: [achievement(ultra, { hoursOwners: baseline.achievements[0].hoursOwners })] });
  assert.equal(result.availability, "unavailable");
  db.close();
});

function profile(aid, counters = raw()) {
  return { aid, updated: 1_800_000_000_000, info: { nickname: `p${aid}`, prestigeLevel: counters.prestige },
    pmcStats: { eft: { totalInGameTime: 100 * 3600, overAllCounters: { Items: [
      [["Sessions", "Pmc"], counters.raids], [["Deaths"], counters.deaths], [["ExitStatus", "Survived", "Pmc"], counters.survived],
      [["Kills"], counters.kills], [["KilledPmc"], counters.killedPmc], [["LongestWinStreak", "Pmc"], counters.streak],
    ].filter(([, v]) => v !== null).map(([Key, Value]) => ({ Key, Value })) } } }, achievements: {} };
}
test("parser and persistent store retain independent raw availability through evaluation", async () => {
  const store = await getStore();
  assert.ok(store);
  for (let aid = 100; aid < 140; aid++) await store.upsert(aid, parseProfileStats(profile(aid, raw({ kills: 100, killedPmc: null }))), []);
  const target = parseProfileStats(profile(999, raw({ killedPmc: null })));
  assert.equal(target.regularRiskInputs.killedPmc, null);
  assert.equal(target.regularRiskInputs.survived, 800);
  assert.equal(target.pvpStatsParserVersion, PVP_STATS_PARSER_VERSION);
  const baseline = await store.riskBaseline(100, 1000, 999);
  assert.equal(baseline.strategy, "matched");
  assert.equal(baseline.metrics.pmc_survival_rate.n, 40);
  assert.equal(baseline.metrics.pmc_kd_ratio.n, 0);
  const result = await evaluateAndStoreRisk({ aid: 999, mode: "regular", stats: target, achievementIds: [], playerStore: store });
  assert.equal(result.availability, "partial");
  assert.ok(result.score > 0);
  const persisted = await getRiskEvaluation({ aid: 999, mode: "regular", cycleId: "persistent" });
  assert.equal(persisted.availability, "partial");
  assert.equal(persisted.profileParserVersion, 2);
  assert.equal(persisted.scoreVersion, 3);
  await saveRiskEvaluation({ ...persisted, score: 0, profileParserVersion: 0 });
  assert.equal((await getRiskEvaluation({ aid: 999, mode: "regular", cycleId: "persistent" })).profileParserVersion, 2);
  const db = new DatabaseSync(process.env.SQLITE_PATH);
  const row = db.prepare("SELECT risk_killed_pmc, risk_survived FROM players WHERE aid=100").get();
  assert.equal(row.risk_killed_pmc, null);
  assert.equal(row.risk_survived, 800);
  db.exec("INSERT INTO excluded_players VALUES (100, 'ban', 1)");
  assert.equal((await store.riskBaseline(100, 1000, 101)).metrics.pmc_survival_rate.n, 38);
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT aid, hours, risk_raids, risk_deaths, risk_survived, risk_kills, risk_killed_pmc, risk_streak, risk_prestige FROM players WHERE hours BETWEEN 70 AND 130 AND pmc_raids BETWEEN 700 AND 1300 AND risk_raids > 0").all();
  assert.ok(plan.some((r) => String(r.detail).includes("COVERING INDEX idx_players_regular_risk")));
  db.close();
});

test("a missing death counter disables KD while preserving exact kills per raid", () => {
  const parsed = parseProfileStats(profile(999, raw({ deaths: null })));
  assert.equal(parsed.regularRiskInputs.deaths, null);
  assert.equal(parsed.regularRiskInputs.killedPmc, 600);
  const baseline = base(peers({ deaths: null }));
  assert.equal(baseline.metrics.pmc_kd_ratio.n, 0);
  assert.equal(baseline.metrics.killed_pmc_per_raid.n, 40);
  const result = scoreRegularCheater(parsed, baseline);
  assert.equal(factor(result, "pmc_kd_ratio").available, false);
  assert.equal(factor(result, "killed_pmc_per_raid").available, true);
});

test("dense matched windows return bounded raw samples using the covering index", async (t) => {
  const db = new DatabaseSync(process.env.SQLITE_PATH);
  const insert = db.prepare(`INSERT INTO players(aid, hours, pmc_raids, fetched_at,
    risk_raids, risk_deaths, risk_survived, risk_kills, risk_killed_pmc, risk_streak, risk_prestige)
    VALUES (?, ?, 1000, 1, 1000, 100, 800, 900, 600, 5, 0)`);
  db.exec("BEGIN");
  for (let aid = 10000; aid < 60000; aid++) insert.run(aid, aid < 20000 ? 100 + (aid % 100) / 100 : 5000);
  db.exec("COMMIT");
  const store = await getStore();
  const startedAt = performance.now();
  const baseline = await store.riskBaseline(100, 1000, 999);
  t.diagnostic(`50,000-row fixture, 10,000 nearby rows, ${baseline.n} returned peers: ${(performance.now() - startedAt).toFixed(1)} ms`);
  assert.equal(baseline.n, 2000);
  assert.ok(baseline.metrics.pmc_kd_ratio.n >= 1960 && baseline.metrics.pmc_kd_ratio.n <= 2000);
  db.close();
});
