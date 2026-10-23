/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript runner requires explicit .ts imports.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createSqliteModerationStore } from "../lib/admin/moderation-db.ts";
import { getPublicIndexCoverage } from "../lib/public-index-coverage.ts";
import { getPublicHomeCounter } from "../lib/public-home-counter.ts";
import { getPublicBanCount } from "../lib/public-ban-counter.ts";
import { captureHomeCounter } from "../lib/home-counter-sampler.ts";
import { initializeBanImportDb, importBanCandidate } from "../lib/ban-import.ts";
import { DAY_MS, homeCounterDay, homeCountAt } from "../lib/home-counter.ts";

const directory = mkdtempSync(join(tmpdir(), "tarkov-index-coverage-"));
const playersPath = join(directory, "players.db");
const progressionPath = join(directory, "progression.db");
const bansPath = join(directory, "bans.db");
const env = { SQLITE_PATH: playersPath, PROGRESSION_SQLITE_PATH: progressionPath, BANS_SQLITE_PATH: bansPath };
const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
Object.assign(process.env, env);
test.after(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});

function writeMeta(rows, table = "player_index_meta", path = playersPath, cycle = null) {
  const db = new DatabaseSync(path);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (${cycle ? "cycle_id TEXT NOT NULL," : ""}
      key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (${cycle ? "cycle_id," : ""} key))`);
    for (const [key, value] of rows) {
      db.prepare(`INSERT OR REPLACE INTO ${table} VALUES (${cycle ? "?," : ""}?, ?)`)
        .run(...(cycle ? [cycle] : []), key, String(value));
    }
  } finally { db.close(); }
}

test("coverage reports unknown before any sync and never creates databases", async () => {
  assert.deepEqual(await getPublicIndexCoverage(), { total: null, syncedAt: null });
  assert.equal(existsSync(playersPath), false);
  assert.equal(existsSync(progressionPath), false);
  writeMeta([]);
  assert.deepEqual(await getPublicIndexCoverage(), { total: null, syncedAt: null });
});

test("coverage serves stored metadata without requiring the player index", async () => {
  writeMeta([["row_count", 2970379], ["synced_at", 1756700000000]]);
  assert.deepEqual(await getPublicIndexCoverage(), { total: 2970379, syncedAt: 1756700000000 });
});

test("coverage rejects invalid counts and missing timestamps", async () => {
  for (const value of ["0", "-5", "not-a-number", "1.5", "", "9007199254740992"]) {
    writeMeta([["row_count", value], ["synced_at", 1756700000000]]);
    assert.equal((await getPublicIndexCoverage()).total, null, `row_count=${value}`);
  }
  writeMeta([["row_count", 10], ["synced_at", ""]]);
  assert.equal((await getPublicIndexCoverage()).total, null);
});

test("coverage sums every mode and Seasonal cycle, with repeats counted per mode", async () => {
  writeMeta([["row_count", 10], ["synced_at", 1000]]);
  writeMeta([["row_count", 20], ["synced_at", 2000]], "pve_player_index_meta");
  writeMeta([["row_count", 30], ["synced_at", 3000]], "arena_player_index_meta");
  writeMeta([["row_count", 40], ["synced_at", 4000]], "seasonal_player_index_meta", progressionPath, "old");
  writeMeta([["row_count", 50], ["synced_at", 5000]], "seasonal_player_index_meta", progressionPath, "current");
  assert.deepEqual(await getPublicIndexCoverage(), { total: 150, syncedAt: 1000 });
  // No source index tables exist: a visitor can only read small metadata tables.
  const db = new DatabaseSync(playersPath, { readOnly: true });
  try { assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='player_index'").get(), undefined); }
  finally { db.close(); }
});

test("coverage never publishes a partial total when a present source is broken", async () => {
  writeMeta([["row_count", "bad"]], "pve_player_index_meta");
  assert.equal((await getPublicIndexCoverage()).total, null);
  writeMeta([["row_count", 20]], "pve_player_index_meta");
  rmSync(progressionPath);
  writeFileSync(progressionPath, "broken database");
  assert.equal((await getPublicIndexCoverage()).total, null);
  rmSync(progressionPath);
});

const startsAt = Date.parse("2026-10-22T21:00:00Z");
test("counter day follows Moscow midnight, independent of host timezone", () => {
  assert.deepEqual(homeCounterDay(startsAt), { startsAt, endsAt: startsAt + DAY_MS });
  assert.equal(homeCounterDay(startsAt - 1).startsAt, startsAt - DAY_MS);
  assert.equal(homeCounterDay(startsAt + DAY_MS).startsAt, startsAt + DAY_MS);
});

test("profile totals interpolate yesterday's net change, clamp, and join days continuously", () => {
  const counter = { from: 100, to: 124, startsAt, endsAt: startsAt + DAY_MS };
  assert.equal(homeCountAt(counter, startsAt - DAY_MS), 100);
  assert.equal(homeCountAt(counter, startsAt), 100);
  assert.equal(homeCountAt(counter, startsAt + DAY_MS / 2), 112);
  assert.equal(homeCountAt(counter, startsAt + DAY_MS), 124);
  assert.equal(homeCountAt(counter, startsAt + 2 * DAY_MS), 124);
  const next = { from: 124, to: 130, startsAt: counter.endsAt, endsAt: counter.endsAt + DAY_MS };
  assert.equal(homeCountAt(next, next.startsAt), homeCountAt(counter, counter.endsAt));
  assert.equal(homeCountAt({ ...counter, to: 100 }, startsAt + DAY_MS / 2), 100);
});

test("public reads are unknown before sampling and never create storage", async () => {
  assert.equal(await getPublicHomeCounter(), null);
  assert.equal(await getPublicBanCount(), null);
  assert.equal(existsSync(progressionPath), false);
  const previousPath = process.env.SQLITE_PATH;
  process.env.SQLITE_PATH = join(directory, "missing-coverage.db");
  try { await assert.rejects(captureHomeCounter(startsAt)); }
  finally { process.env.SQLITE_PATH = previousPath; }
  assert.equal(existsSync(bansPath), false);
  assert.equal(existsSync(progressionPath), false);
});

let fixtureId = 0;
async function counterFixture(run) {
  const prefix = `counter-${fixtureId++}`;
  const paths = {
    SQLITE_PATH: join(directory, `${prefix}-players.db`),
    PROGRESSION_SQLITE_PATH: join(directory, `${prefix}-progression.db`),
    BANS_SQLITE_PATH: join(directory, `${prefix}-bans.db`),
    REPORTS_SQLITE_PATH: join(directory, `${prefix}-reports.db`),
  };
  const old = Object.fromEntries(Object.keys(paths).map(key => [key, process.env[key]]));
  Object.assign(process.env, paths);
  const bans = new DatabaseSync(paths.BANS_SQLITE_PATH);
  const progression = new DatabaseSync(paths.PROGRESSION_SQLITE_PATH);
  const players = new DatabaseSync(paths.SQLITE_PATH);
  initializeBanImportDb(bans);
  progression.exec(`CREATE TABLE upstream_ban_confirmations (
    aid INTEGER,mode TEXT,cycle_id TEXT,source TEXT,confirmed_at INTEGER,
    PRIMARY KEY(aid,mode,cycle_id,source));
    CREATE TABLE player_profiles(aid INTEGER,mode TEXT,cycle_id TEXT,confirmed_banned INTEGER);`);
  players.exec("CREATE TABLE player_index_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  const setTotal = n => {
    players.prepare("INSERT OR REPLACE INTO player_index_meta VALUES ('row_count',?)").run(String(n));
    players.prepare("INSERT OR REPLACE INTO player_index_meta VALUES ('synced_at',?)").run(String(startsAt));
  };
  setTotal(100);
  const archive = aid => bans.prepare(`INSERT INTO banned_accounts VALUES (?,?,?,'admin_manual','confirmed',NULL,1)`)
    .run(aid, startsAt, startsAt);
  const upstream = (aid, source = "seasonal_upstream", timestamp = startsAt) => progression.prepare(`
    INSERT OR REPLACE INTO upstream_ban_confirmations VALUES (?,'seasonal','s1',?,?)`).run(aid, source, timestamp);
  try { await run({ bans, progression, players, archive, upstream, paths, setTotal }); }
  finally {
    bans.close(); progression.close(); players.close();
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const at = (day, elapsed = 0) => startsAt + day * DAY_MS + elapsed;
const end = day => at(day + 1) - 60_000;
const observedTotal = db => Number(db.prepare("SELECT total FROM home_coverage_daily ORDER BY day_start DESC LIMIT 1").get().total);

test("profile sampler starts with a stable baseline and never invents growth", async () => {
  await counterFixture(async ({ progression, setTotal }) => {
    assert.equal(await getPublicHomeCounter(), null);
    const baseline = await captureHomeCounter(at(0, 1000));
    assert.equal(baseline.from, 100); assert.equal(baseline.to, 100);
    setTotal(110);
    assert.deepEqual(await captureHomeCounter(at(0, 2000)), baseline);
    assert.equal(observedTotal(progression), 110);
  });
});

test("profile sampling runs without visitors, smooths yesterday's growth and survives restart", async () => {
  await counterFixture(async ({ setTotal, progression }) => {
    setTotal(10);
    await captureHomeCounter(at(0, DAY_MS / 2));
    setTotal(12); await captureHomeCounter(end(0));
    const first = await captureHomeCounter(at(1, 1000));
    assert.deepEqual(first, { from: 10, to: 12, startsAt: at(1, 1000), endsAt: at(2) });
    setTotal(15); await captureHomeCounter(end(1));
    await captureHomeCounter(at(2));
    const second = await captureHomeCounter(at(2, DAY_MS / 2));
    assert.deepEqual(second, { from: 12, to: 15, startsAt: at(2), endsAt: at(3) });
    assert.equal(homeCountAt(second, at(2, DAY_MS / 2)), 13);
    assert.deepEqual(await getPublicHomeCounter(), second);
    const child = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
      "const {getPublicHomeCounter}=await import('./lib/public-home-counter.ts'); console.log(JSON.stringify(await getPublicHomeCounter()));"],
      { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 10_000 });
    assert.deepEqual(JSON.parse(child), second);
    assert.equal(progression.prepare("SELECT COUNT(*) n FROM home_coverage_daily").get().n, 3);
  });
});

test("banned count is the current database total, without time interpolation or duplicate AIDs", async () => {
  await counterFixture(async ({ bans, archive, upstream }) => {
    assert.equal(await getPublicBanCount(), 0);
    archive(42); upstream(42); upstream(43, "legacy_unknown", 0);
    assert.equal(await getPublicBanCount(), 2);
    assert.equal(await getPublicBanCount(), 2, "time and repeated reads cannot add banned accounts");
    bans.exec("DELETE FROM banned_accounts WHERE aid=42");
    assert.equal(await getPublicBanCount(), 2, "an upstream confirmation still counts the same AID");
    archive(44);
    assert.equal(await getPublicBanCount(), 3, "only a real database change adds a banned account");
    bans.exec("DELETE FROM banned_accounts WHERE aid=44");
    assert.equal(await getPublicBanCount(), 2);
  });
});

test("new evidence for a banned AID does not change its count or the profile-counter history", async () => {
  await counterFixture(async ({ bans, progression, upstream }) => {
    upstream(42, "legacy_unknown", 0);
    const baseline = await captureHomeCounter(at(0, 1000));
    assert.equal(await getPublicBanCount(), 1);
    const candidate = { aid: 42, nickname: "Player", waves: [
      { date: "2025-12-19", source: "https://example.com/bans", nicknames: ["Player"] },
    ] };
    const profile = { mode: "regular", raw: JSON.stringify({ aid: 42, updated: 1766100000000,
      info: { nickname: "Player", side: "Usec", experience: 10000 },
      skills: { Common: [{ Id: "Strength", Progress: 100, LastAccess: 1766000000 }] },
      pmcStats: { eft: { totalInGameTime: 1234, overAllCounters: { Items: [] } } }, achievements: {},
    }) };
    assert.equal(importBanCandidate(bans, candidate, [profile], at(0, 2000), () => {}), "accepted");
    assert.equal(await getPublicBanCount(), 1);
    assert.deepEqual(await captureHomeCounter(at(0, 3000)), baseline);
    upstream(43, "seasonal_upstream", at(0, 4000));
    progression.exec("INSERT INTO player_profiles VALUES (43,'seasonal','s1',1)");
    const admin = new DatabaseSync(join(directory, `${fixtureId}-admin.db`));
    try { createSqliteModerationStore(admin); } finally { admin.close(); }
    assert.equal(await getPublicBanCount(), 2);
    assert.deepEqual(await captureHomeCounter(end(0)), baseline);
    assert.equal(observedTotal(progression), 100);
  });
});

test("profile totals also reveal a verified decrease instead of artificial growth", async () => {
  await counterFixture(async ({ setTotal }) => {
    await captureHomeCounter(at(0, 1000));
    setTotal(90); await captureHomeCounter(end(0));
    const tomorrow = await captureHomeCounter(at(1, 1000));
    assert.equal(tomorrow.from, 100); assert.equal(tomorrow.to, 90);
  });
});

test("missed endpoints freeze a target and midday recovery remains continuous", async () => {
  await counterFixture(async ({ setTotal, progression }) => {
    setTotal(1); await captureHomeCounter(at(0, 1000));
    setTotal(2); await captureHomeCounter(end(0));
    const lastGood = await captureHomeCounter(at(1, DAY_MS / 2));
    setTotal(3);
    assert.deepEqual(await captureHomeCounter(at(2, DAY_MS / 2)), lastGood);
    assert.equal(homeCountAt(await getPublicHomeCounter(), at(2)), 2);
    await captureHomeCounter(end(2));
    assert.deepEqual(await captureHomeCounter(at(3, 1000)), lastGood);
    setTotal(4); await captureHomeCounter(end(3));
    const recoveryAt = at(4, DAY_MS / 2);
    const before = homeCountAt(await getPublicHomeCounter(), recoveryAt);
    const recovered = await captureHomeCounter(recoveryAt);
    assert.deepEqual(recovered, { from: 2, to: 4, startsAt: recoveryAt, endsAt: at(5) });
    assert.equal(homeCountAt(recovered, recoveryAt), before);
    await captureHomeCounter(end(4));
    const nextDay = await captureHomeCounter(at(5, 1000));
    assert.equal(homeCountAt(nextDay, nextDay.startsAt), homeCountAt(recovered, recovered.endsAt));
    assert.equal(progression.prepare("SELECT observed_at FROM home_coverage_daily WHERE day_start=?").get(at(1)).observed_at, at(1, DAY_MS / 2));
  });
});

test("unavailable metadata and write locks cannot overwrite good profile snapshots", async () => {
  await counterFixture(async ({ progression, paths }) => {
    const baseline = await captureHomeCounter(at(0, 1000));
    process.env.SQLITE_PATH = join(directory, "missing-authority.db");
    try { await assert.rejects(captureHomeCounter(at(0, 2000))); }
    finally { process.env.SQLITE_PATH = paths.SQLITE_PATH; }
    assert.equal(existsSync(join(directory, "missing-authority.db")), false);
    assert.equal(progression.prepare("SELECT observed_at FROM home_coverage_daily").get().observed_at, at(0, 1000));
    progression.exec("BEGIN IMMEDIATE");
    try { await assert.rejects(captureHomeCounter(at(0, 3000)), /locked/); }
    finally { progression.exec("ROLLBACK"); }
    assert.deepEqual(await getPublicHomeCounter(), baseline);
    await assert.rejects(captureHomeCounter(at(0, 999)), /clock moved backwards/);
    assert.equal(progression.prepare("SELECT observed_at FROM home_coverage_daily").get().observed_at, at(0, 1000));
  });
});

test("the deployed coverage sampler captures once and terminates", async () => {
  await counterFixture(async ({ setTotal }) => {
    setTotal(42);
    execFileSync(process.execPath, ["--experimental-strip-types", "--experimental-sqlite", "scripts/sample-home-coverage.mjs", "--once"],
      { cwd: process.cwd(), env: process.env, timeout: 10_000, stdio: "pipe" });
    assert.equal((await getPublicHomeCounter()).from, 42);
  });
});
