/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript runner requires explicit .ts imports.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { getPublicIndexCoverage } from "../lib/public-index-coverage.ts";
import { getPublicBanCounter } from "../lib/public-ban-counter.ts";
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

test("missing ban storage stays unknown and is not created", async () => {
  assert.equal(await getPublicBanCounter(startsAt), null);
  assert.equal(existsSync(bansPath), false);
});

test("ban counter counts unique accounts by first confirmation, including imported and legacy bans", async () => {
  const db = new DatabaseSync(bansPath);
  try {
    db.exec(`CREATE TABLE banned_accounts(aid INTEGER PRIMARY KEY, first_banned_at INTEGER);
      CREATE TABLE ban_confirmations(aid INTEGER, confirmed_at INTEGER);
      CREATE INDEX idx_ban_confirmations_aid_time ON ban_confirmations(aid, confirmed_at);`);
    assert.deepEqual(await getPublicBanCounter(startsAt), { from: 0, to: 0, startsAt, endsAt: startsAt + DAY_MS });
    const account = db.prepare("INSERT INTO banned_accounts VALUES (?,?)");
    const confirm = db.prepare("INSERT INTO ban_confirmations VALUES (?,?)");
    account.run(1, startsAt - 10 * DAY_MS); // old account, confirmed again yesterday
    confirm.run(1, startsAt - 10 * DAY_MS);
    confirm.run(1, startsAt - 1000);
    account.run(2, startsAt - 10 * DAY_MS); // old wave, first imported yesterday
    confirm.run(2, startsAt - 1000);
    confirm.run(2, startsAt - 500);
    account.run(3, startsAt); // today's addition waits until tomorrow
    confirm.run(3, startsAt);
    account.run(4, startsAt - 3 * DAY_MS); // legacy ban without confirmations
    account.run(5, startsAt - DAY_MS); // exact start of yesterday
    confirm.run(5, startsAt - DAY_MS);
    account.run(6, startsAt + DAY_MS); // future confirmation is not counted
    assert.deepEqual(await getPublicBanCounter(startsAt + DAY_MS / 2), {
      from: 2, to: 4, startsAt, endsAt: startsAt + DAY_MS,
    });
    const tomorrow = await getPublicBanCounter(startsAt + DAY_MS);
    assert.equal(tomorrow.from, 4);
    assert.equal(tomorrow.to, 5);
  } finally { db.close(); }
});

test("upstream bans across modes and cycles merge with the archive by AID", async () => {
  const db = new DatabaseSync(progressionPath);
  try {
    db.exec(`CREATE TABLE upstream_ban_confirmations(aid INTEGER,mode TEXT,cycle_id TEXT,confirmed_at INTEGER)`);
    const add = db.prepare("INSERT INTO upstream_ban_confirmations VALUES (?,?,?,?)");
    add.run(2, "seasonal", "s1", startsAt - 2 * DAY_MS); // same archived AID, earlier confirmation
    add.run(7, "seasonal", "s1", startsAt - 1000);
    add.run(7, "seasonal", "s2", startsAt - 500); // duplicate in another cycle
    add.run(8, "regular", "persistent", startsAt - 4 * DAY_MS);
    assert.deepEqual(await getPublicBanCounter(startsAt), { from: 4, to: 6, startsAt, endsAt: startsAt + DAY_MS });
    // With no archive database, the upstream source still supplies a real count.
    rmSync(bansPath);
    assert.deepEqual(await getPublicBanCounter(startsAt), { from: 2, to: 3, startsAt, endsAt: startsAt + DAY_MS });
  } finally { db.close(); }
});

test("unreadable ban storage never becomes zero bans", async () => {
  writeFileSync(bansPath, "broken");
  assert.equal(await getPublicBanCounter(startsAt), null);
});
