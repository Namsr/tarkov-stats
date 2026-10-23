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
import { getPublicBanCounter } from "../lib/public-ban-counter.ts";
import { captureHomeBanCounter } from "../lib/home-ban-sampler.ts";
import { initializeBanImportDb, importBanCandidate } from "../lib/ban-import.ts";
import { DAY_MS, homeCounterDay, homeBanCountAt } from "../lib/home-ban-counter.ts";

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

test("bans interpolate yesterday's confirmed additions, clamp, and join days continuously", () => {
  const counter = { from: 100, to: 124, startsAt, endsAt: startsAt + DAY_MS };
  assert.equal(homeBanCountAt(counter, startsAt - DAY_MS), 100);
  assert.equal(homeBanCountAt(counter, startsAt), 100);
  assert.equal(homeBanCountAt(counter, startsAt + DAY_MS / 2), 112);
  assert.equal(homeBanCountAt(counter, startsAt + DAY_MS), 124);
  assert.equal(homeBanCountAt(counter, startsAt + 2 * DAY_MS), 124);
  const next = { from: 124, to: 130, startsAt: counter.endsAt, endsAt: counter.endsAt + DAY_MS };
  assert.equal(homeBanCountAt(next, next.startsAt), homeBanCountAt(counter, counter.endsAt));
  assert.equal(homeBanCountAt({ ...counter, to: 100 }, startsAt + DAY_MS / 2), 100);
});

test("public reads are unknown before sampling and never create storage", async () => {
  assert.equal(await getPublicBanCounter(), null);
  assert.equal(existsSync(progressionPath), false);
  await assert.rejects(captureHomeBanCounter(startsAt));
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
  initializeBanImportDb(bans);
  progression.exec(`CREATE TABLE upstream_ban_confirmations (
    aid INTEGER,mode TEXT,cycle_id TEXT,source TEXT,confirmed_at INTEGER,
    PRIMARY KEY(aid,mode,cycle_id,source));
    CREATE TABLE player_profiles(aid INTEGER,mode TEXT,cycle_id TEXT,confirmed_banned INTEGER);`);
  const archive = (aid) => bans.prepare(`INSERT INTO banned_accounts VALUES (?,?,?,'admin_manual','confirmed',NULL,1)`)
    .run(aid, startsAt, startsAt);
  const upstream = (aid, source = "seasonal_upstream", at = startsAt) => progression.prepare(`
    INSERT OR REPLACE INTO upstream_ban_confirmations VALUES (?,'seasonal','s1',?,?)`).run(aid, source, at);
  try { await run({ bans, progression, archive, upstream, paths }); }
  finally {
    bans.close(); progression.close();
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const at = (day, elapsed = 0) => startsAt + day * DAY_MS + elapsed;
const end = (day) => at(day + 1) - 60_000;
const observedTotal = db => Number(db.prepare("SELECT total FROM home_ban_daily ORDER BY day_start DESC LIMIT 1").get().total);

test("sampler records zero only from readable authorities and starts with a stable baseline", async () => {
  await counterFixture(async ({ progression, archive }) => {
    assert.equal(await getPublicBanCounter(), null);
    const zero = await captureHomeBanCounter(at(0, 1000));
    assert.equal(zero.from, 0); assert.equal(zero.to, 0);
    archive(42);
    assert.deepEqual(await captureHomeBanCounter(at(0, 2000)), zero);
    assert.equal(observedTotal(progression), 1);
  });
});

test("sampling runs without visitors, smooths yesterday's net growth and survives reopen", async () => {
  await counterFixture(async ({ archive, upstream, progression }) => {
    for (let aid = 1; aid <= 10; aid++) archive(aid);
    await captureHomeBanCounter(at(0, DAY_MS / 2));
    upstream(1); // overlapping authority, never another account
    upstream(11); upstream(12);
    await captureHomeBanCounter(end(0));
    const first = await captureHomeBanCounter(at(1, 1000));
    assert.deepEqual(first, { from: 10, to: 12, startsAt: at(1, 1000), endsAt: at(2) });
    for (let aid = 13; aid <= 15; aid++) upstream(aid);
    await captureHomeBanCounter(end(1));
    await captureHomeBanCounter(at(2));
    const second = await captureHomeBanCounter(at(2, DAY_MS / 2));
    assert.deepEqual(second, { from: 12, to: 15, startsAt: at(2), endsAt: at(3) });
    assert.equal(homeBanCountAt(second, at(2, DAY_MS / 2)), 13);
    // No public read occurred on either collection day; each call reopens storage.
    assert.deepEqual(await getPublicBanCounter(), second);
    const child = execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
      "const {getPublicBanCounter}=await import('./lib/public-ban-counter.ts'); console.log(JSON.stringify(await getPublicBanCounter()));"],
      { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 10_000 });
    assert.deepEqual(JSON.parse(child), second);
    assert.equal(progression.prepare("SELECT COUNT(*) n FROM home_ban_daily").get().n, 3);
  });
});

test("legacy-to-imported evidence and later synthetic provenance never change the total", async () => {
  await counterFixture(async ({ bans, progression, upstream, paths }) => {
    upstream(42, "legacy_unknown", 0);
    const baseline = await captureHomeBanCounter(at(0, 1000));
    const candidate = { aid: 42, nickname: "Player", waves: [
      { date: "2025-12-19", source: "https://example.com/bans", nicknames: ["Player"] },
    ] };
    const profile = { mode: "regular", raw: JSON.stringify({ aid: 42, updated: 1766100000000,
      info: { nickname: "Player", side: "Usec", experience: 10000 },
      skills: { Common: [{ Id: "Strength", Progress: 100, LastAccess: 1766000000 }] },
      pmcStats: { eft: { totalInGameTime: 1234, overAllCounters: { Items: [] } } }, achievements: {},
    }) };
    assert.equal(importBanCandidate(bans, candidate, [profile], at(0, 2000), () => {}), "accepted");
    assert.deepEqual(await captureHomeBanCounter(at(0, 3000)), baseline);
    assert.equal(observedTotal(progression), 1);
    upstream(43, "seasonal_upstream", at(0, 4000));
    progression.exec("INSERT INTO player_profiles VALUES (43,'seasonal','s1',1)");
    const admin = new DatabaseSync(join(directory, `${fixtureId}-admin.db`));
    try { createSqliteModerationStore(admin); } finally { admin.close(); }
    assert.equal(progression.prepare("SELECT confirmed_at FROM upstream_ban_confirmations WHERE aid=43 AND source='legacy_unknown'").get().confirmed_at, 0);
    assert.deepEqual(await captureHomeBanCounter(end(0)), baseline);
    assert.equal(observedTotal(progression), 2);
    const tomorrow = await captureHomeBanCounter(at(1, 1000));
    assert.equal(tomorrow.from, 1); assert.equal(tomorrow.to, 2);
    assert.ok(existsSync(paths.PROGRESSION_SQLITE_PATH));
  });
});

test("manual restore and re-ban between samples do not count the account twice", async () => {
  await counterFixture(async ({ bans, progression, archive }) => {
    archive(42);
    const baseline = await captureHomeBanCounter(at(0, 1000));
    bans.exec("DELETE FROM banned_accounts WHERE aid=42");
    archive(42);
    assert.deepEqual(await captureHomeBanCounter(at(0, 2000)), baseline);
    assert.equal(observedTotal(progression), 1);
    bans.exec("DELETE FROM banned_accounts WHERE aid=42");
    await captureHomeBanCounter(end(0));
    const tomorrow = await captureHomeBanCounter(at(1, 1000));
    assert.equal(tomorrow.from, 1); assert.equal(tomorrow.to, 0);
  });
});

test("missed endpoints freeze a persisted target and recovery catches up without invented days", async () => {
  await counterFixture(async ({ archive, upstream, progression }) => {
    archive(1);
    await captureHomeBanCounter(at(0, 1000));
    upstream(2); await captureHomeBanCounter(end(0));
    const lastGood = await captureHomeBanCounter(at(1, DAY_MS / 2));
    upstream(3);
    // No sample near day 1's midnight: day 2 must retain the old window.
    assert.deepEqual(await captureHomeBanCounter(at(2, DAY_MS / 2)), lastGood);
    assert.equal(homeBanCountAt(await getPublicBanCounter(), at(2)), 2);
    await captureHomeBanCounter(end(2));
    assert.deepEqual(await captureHomeBanCounter(at(3, 1000)), lastGood);
    upstream(4); await captureHomeBanCounter(end(3));
    const recoveryAt = at(4, DAY_MS / 2);
    const before = homeBanCountAt(await getPublicBanCounter(), recoveryAt);
    const recovered = await captureHomeBanCounter(recoveryAt);
    assert.deepEqual(recovered, { from: 2, to: 4, startsAt: recoveryAt, endsAt: at(5) });
    assert.equal(homeBanCountAt(recovered, recoveryAt), before, "publication cannot jump halfway through the backlog");
    await captureHomeBanCounter(end(4));
    const nextDay = await captureHomeBanCounter(at(5, 1000));
    assert.equal(homeBanCountAt(nextDay, nextDay.startsAt), homeBanCountAt(recovered, recovered.endsAt));
    assert.equal(progression.prepare("SELECT observed_at FROM home_ban_daily WHERE day_start=?").get(at(1)).observed_at, at(1, DAY_MS / 2));
  });
});

test("unavailable sources and write locks cannot overwrite good snapshots", async () => {
  await counterFixture(async ({ archive, progression, paths }) => {
    archive(42);
    const baseline = await captureHomeBanCounter(at(0, 1000));
    process.env.BANS_SQLITE_PATH = join(directory, "missing-authority.db");
    try { await assert.rejects(captureHomeBanCounter(at(0, 2000))); }
    finally { process.env.BANS_SQLITE_PATH = paths.BANS_SQLITE_PATH; }
    assert.equal(existsSync(join(directory, "missing-authority.db")), false);
    assert.equal(progression.prepare("SELECT observed_at FROM home_ban_daily").get().observed_at, at(0, 1000));
    progression.exec("BEGIN IMMEDIATE");
    try { await assert.rejects(captureHomeBanCounter(at(0, 3000)), /locked/); }
    finally { progression.exec("ROLLBACK"); }
    assert.deepEqual(await getPublicBanCounter(), baseline);
    await assert.rejects(captureHomeBanCounter(at(0, 999)), /clock moved backwards/);
    assert.equal(progression.prepare("SELECT observed_at FROM home_ban_daily").get().observed_at, at(0, 1000));
  });
});

test("the deployed sampler can capture once and terminate", async () => {
  await counterFixture(async ({ archive }) => {
    archive(42);
    execFileSync(process.execPath, ["--experimental-strip-types", "--experimental-sqlite", "scripts/sample-home-bans.mjs", "--once"],
      { cwd: process.cwd(), env: process.env, timeout: 10_000, stdio: "pipe" });
    assert.equal((await getPublicBanCounter()).from, 1);
  });
});
