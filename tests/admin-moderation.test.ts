/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- node:sqlite types are not present in the project's Node 20 type package.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createSqliteModerationStore, getRiskEvaluation, ModerationConflictError } from "../lib/admin/moderation-db.ts";
import { isValidMutationOrigin } from "../lib/admin/origin.ts";
import { createSqliteBanStore } from "../lib/ban-db.ts";
import { createSqliteSeasonalStore } from "../lib/seasonal/storage.ts";
import { materializeRegularProgression } from "../lib/regular-progression.ts";

test("cold public risk read does not wait for moderation migration writes", () => {
  const directory = mkdtempSync(join(tmpdir(), "risk-read-"));
  const file = join(directory, "admin.db");
  const setup = new DatabaseSync(file);
  createSqliteModerationStore(setup, { attachExternal: false }).saveRisk({
    aid: 42, mode: "seasonal", cycleId: "s1", score: 45, tier: "high", factors: [],
    scoreVersion: 1, profileUpdatedAt: 10, evaluatedAt: 20, sampleN: 30,
    confidence: 1, freshnessAt: 19,
  });
  setup.close();
  const locker = new DatabaseSync(file);
  locker.exec("BEGIN IMMEDIATE");
  try {
    const output = execFileSync(process.execPath, [
      "--experimental-strip-types",
      "--experimental-sqlite",
      "--input-type=module",
      "-e",
      `const { getRiskEvaluation } = await import('./lib/admin/moderation-db.ts');
       const risk = await getRiskEvaluation({ aid: 42, mode: 'seasonal', cycleId: 's1' });
       console.log(JSON.stringify({ score: risk?.score, profileUpdatedAt: risk?.profileUpdatedAt,
         evaluatedAt: risk?.evaluatedAt, sampleN: risk?.sampleN, confidence: risk?.confidence,
         freshnessAt: risk?.freshnessAt }));`,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, NODE_NO_WARNINGS: "1", ADMIN_ANALYTICS_SQLITE_PATH: file },
      timeout: 2_000,
    });
    assert.deepEqual(JSON.parse(output), {
      score: 45, profileUpdatedAt: 10, evaluatedAt: 20, sampleN: 30, confidence: 1, freshnessAt: 19,
    });
  } finally {
    locker.exec("ROLLBACK");
    locker.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("public risk read fails soft for missing and legacy storage", () => {
  const directory = mkdtempSync(join(tmpdir(), "risk-read-legacy-"));
  const missing = join(directory, "missing.db");
  const legacy = join(directory, "legacy.db");
  const legacyDb = new DatabaseSync(legacy);
  legacyDb.exec(`CREATE TABLE risk_evaluations (
    aid INTEGER NOT NULL, mode TEXT NOT NULL, cycle_id TEXT NOT NULL, score INTEGER NOT NULL,
    tier TEXT NOT NULL, factors_json TEXT NOT NULL, score_version INTEGER NOT NULL,
    profile_updated_at INTEGER NOT NULL, evaluated_at INTEGER NOT NULL,
    PRIMARY KEY (aid, mode, cycle_id));
    INSERT INTO risk_evaluations VALUES (42, 'seasonal', 's1', 25, 'medium', '[]', 1, 10, 20);`);
  legacyDb.close();
  try {
    const output = execFileSync(process.execPath, [
      "--experimental-strip-types", "--experimental-sqlite", "--input-type=module", "-e",
      `const { getRiskEvaluation } = await import('./lib/admin/moderation-db.ts');
       process.env.ADMIN_ANALYTICS_SQLITE_PATH = ${JSON.stringify(missing)};
       const missingRisk = await getRiskEvaluation({ aid: 42, mode: 'seasonal', cycleId: 's1' });
       process.env.ADMIN_ANALYTICS_SQLITE_PATH = ${JSON.stringify(legacy)};
       const legacyRisk = await getRiskEvaluation({ aid: 42, mode: 'seasonal', cycleId: 's1' });
       console.log(JSON.stringify({ missingRisk, score: legacyRisk?.score,
         sampleN: legacyRisk?.sampleN, freshnessAt: legacyRisk?.freshnessAt }));`,
    ], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" }, timeout: 2_000 });
    assert.deepEqual(JSON.parse(output), { missingRisk: null, score: 25, sampleN: null, freshnessAt: null });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("public risk read still rejects an invalid account id", async () => {
  await assert.rejects(
    getRiskEvaluation({ aid: 0, mode: "seasonal", cycleId: "s1" }),
    /invalid aid/,
  );
});

function fixture(options: { walExclusions?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "admin-moderation-"));
  process.env.BANS_SQLITE_PATH = join(directory, "bans.db");
  process.env.SQLITE_PATH = join(directory, "players.db");
  process.env.PROGRESSION_SQLITE_PATH = join(directory, "progression.db");
  process.env.REPORTS_SQLITE_PATH = join(directory, "reports.db");
  const players = new DatabaseSync(process.env.SQLITE_PATH);
  if (options.walExclusions) players.exec("PRAGMA journal_mode = WAL");
  players.exec("CREATE TABLE players (aid INTEGER PRIMARY KEY, nickname TEXT); INSERT INTO players VALUES (42, 'Kept');");
  players.close();
  const progression = new DatabaseSync(process.env.PROGRESSION_SQLITE_PATH);
  if (options.walExclusions) progression.exec("PRAGMA journal_mode = WAL");
  progression.exec(`CREATE TABLE player_profiles (
    mode TEXT, cycle_id TEXT, aid INTEGER, confirmed_banned INTEGER DEFAULT 0,
    PRIMARY KEY (mode, cycle_id, aid));
    INSERT INTO player_profiles VALUES ('seasonal', 's1', 42, 0);`);
  progression.close();
  const reports = new DatabaseSync(process.env.REPORTS_SQLITE_PATH);
  reports.exec(`CREATE TABLE suspect_reports (
    user_sub TEXT, aid INTEGER, mode TEXT, cycle_id TEXT, created_at INTEGER,
    PRIMARY KEY (user_sub, aid));
    INSERT INTO suspect_reports VALUES ('private-user', 42, 'regular', 'persistent', 1);`);
  reports.close();
  const db = new DatabaseSync(join(directory, "admin.db"));
  return { directory, db, store: createSqliteModerationStore(db) };
}

test("risk, reports, reviews, and bans stay distinct and manual restore retains data", () => {
  const { directory, db, store } = fixture();
  try {
    store.saveRisk({ aid: 42, mode: "regular", cycleId: "persistent", score: 45,
      tier: "high", factors: [], scoreVersion: 1, profileUpdatedAt: 10, evaluatedAt: 20 });
    store.saveRisk({ aid: 42, mode: "regular", cycleId: "persistent", score: 0,
      tier: "low", factors: [], scoreVersion: 1, profileUpdatedAt: 9, evaluatedAt: 21 });
    store.setReview({ aid: 42, status: "false_positive", note: "Checked", now: 30 });
    let row = store.forAids([42])[0];
    assert.deepEqual(store.suspiciousAids(), [42]);
    assert.deepEqual([row.sources.automaticRisk, row.sources.communityReports, row.sources.confirmedBan], [true, 1, false]);
    assert.deepEqual(row.review, { status: "false_positive", note: "Checked", updatedAt: 30 });
    store.confirmManualBan({ aid: 42, reason: "Manual evidence", now: 40 });
    row = store.forAids([42])[0];
    assert.equal(row.sources.confirmedBan, true);
    assert.equal(row.canRestoreManualBan, true);
    assert.equal(row.review.status, "confirmed");
    assert.ok(db.prepare("SELECT 1 FROM players_db.players WHERE aid = 42").get(), "source row is retained");
    assert.ok(db.prepare("SELECT 1 FROM players_db.excluded_players WHERE aid = 42").get());
    assert.equal(db.prepare("SELECT confirmed_banned FROM progression_db.player_profiles WHERE aid = 42").get().confirmed_banned, 1);
    createSqliteModerationStore(db);
    assert.equal(db.prepare("SELECT 1 FROM progression_db.upstream_ban_confirmations WHERE aid = 42").get(), undefined);
    store.restoreManualBan({ aid: 42, now: 50 });
    row = store.forAids([42])[0];
    assert.equal(row.sources.confirmedBan, false);
    assert.equal(row.review.status, "reviewed");
    assert.equal(db.prepare("SELECT 1 FROM players_db.excluded_players WHERE aid = 42").get(), undefined);
    assert.equal(db.prepare("SELECT confirmed_banned FROM progression_db.player_profiles WHERE aid = 42").get().confirmed_banned, 0);
    assert.deepEqual(db.prepare("SELECT action FROM admin_audit_log ORDER BY id").all().map((item) => item.action), ["review", "ban", "restore"]);
    assert.deepEqual(db.prepare("SELECT detail FROM admin_audit_log ORDER BY id").all()
      .map((item) => item.detail), [null, null, null]);
    assert.equal(db.prepare("PRAGMA main.journal_mode").get().journal_mode, "delete");
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("moderation store returns progression snapshot totals with mode filtering", () => {
  const { directory, db, store } = fixture();
  try {
    db.exec(`
      ALTER TABLE progression_db.player_profiles ADD COLUMN snapshot_count INTEGER NOT NULL DEFAULT 0;
      UPDATE progression_db.player_profiles SET snapshot_count = 3 WHERE aid = 42;
      CREATE TABLE progression_db.progression_snapshots (mode TEXT NOT NULL, aid INTEGER NOT NULL);
      INSERT INTO progression_db.progression_snapshots VALUES ('regular', 42), ('regular', 42);
    `);
    assert.deepEqual([...store.snapshotCounts([42])], [[42, 3]]);
    assert.deepEqual([...store.snapshotCounts([42], "regular")], [[42, 2]]);
    assert.deepEqual([...store.snapshotCounts([42], "seasonal")], [[42, 3]]);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("automatic suspicious accounts can be separated from user-marked accounts", () => {
  const { directory, db, store } = fixture();
  try {
    store.saveRisk({ aid: 42, mode: "regular", cycleId: "persistent", score: 45,
      tier: "high", factors: [], scoreVersion: 1, profileUpdatedAt: 10, evaluatedAt: 20 });
    db.prepare(`INSERT INTO reports_db.suspect_reports
      (user_sub, aid, mode, cycle_id, created_at)
      VALUES ('another-user', 43, 'regular', 'persistent', 2)`).run();
    assert.deepEqual(store.automaticSuspiciousAids(), [42]);
    assert.deepEqual(new Set(store.suspiciousAids()), new Set([42, 43]));
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("admin mutations accept the public origin behind a reverse proxy", () => {
  const previous = process.env.PUBLIC_BASE_URL;
  process.env.PUBLIC_BASE_URL = "https://tarkovstats.ru";
  try {
    assert.equal(isValidMutationOrigin(new Request("http://web:3000/api/admin/bans", {
      headers: {
        origin: "https://tarkovstats.ru",
        host: "web:3000",
        "x-forwarded-host": "tarkovstats.ru",
        "x-forwarded-proto": "https",
      },
    })), true);
    assert.equal(isValidMutationOrigin(new Request("http://web:3000/api/admin/bans", {
      headers: { origin: "https://evil.example", "x-forwarded-host": "tarkovstats.ru", "x-forwarded-proto": "https" },
    })), false);
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = previous;
  }
});

test("upstream confirmation prevents administrator ban override and restore", () => {
  const { directory, db, store } = fixture();
  try {
    db.prepare("INSERT INTO bans_db.banned_accounts VALUES (42, 10, 10, 'upstream', 'banned', NULL, 1)").run();
    db.prepare("INSERT INTO bans_db.ban_confirmations (aid, confirmed_at, source, raw_status) VALUES (42, 10, 'upstream', 'banned')").run();
    assert.throws(() => store.restoreManualBan({ aid: 42 }), ModerationConflictError);
    assert.throws(() => store.confirmManualBan({ aid: 42, reason: "No override" }), ModerationConflictError);
    assert.ok(db.prepare("SELECT 1 FROM bans_db.banned_accounts WHERE aid = 42").get());
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("Seasonal-only upstream provenance prevents administrator override and restore", () => {
  const { directory, db, store } = fixture();
  try {
    db.prepare(`INSERT INTO progression_db.upstream_ban_confirmations
      (aid, mode, cycle_id, source, confirmed_at)
      VALUES (42, 'seasonal', 's1', 'seasonal_upstream', 10)`).run();
    db.prepare("UPDATE progression_db.player_profiles SET confirmed_banned = 1 WHERE aid = 42").run();
    const row = store.forAids([42])[0];
    assert.equal(row.sources.confirmedBan, true);
    assert.equal(row.banSource, "seasonal_upstream");
    assert.equal(row.canRestoreManualBan, false);
    assert.throws(() => store.restoreManualBan({ aid: 42 }), ModerationConflictError);
    assert.throws(() => store.confirmManualBan({ aid: 42, reason: "No override" }), ModerationConflictError);
    assert.equal(db.prepare("SELECT confirmed_banned FROM progression_db.player_profiles WHERE aid = 42").get().confirmed_banned, 1);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("legacy Seasonal confirmed flag is backfilled as unknown upstream provenance", () => {
  const { directory, db } = fixture();
  try {
    db.prepare("UPDATE progression_db.player_profiles SET confirmed_banned = 1 WHERE aid = 42").run();
    const store = createSqliteModerationStore(db);
    assert.equal(db.prepare(`SELECT source FROM progression_db.upstream_ban_confirmations
      WHERE aid = 42`).get().source, "legacy_unknown");
    assert.throws(() => store.restoreManualBan({ aid: 42 }), ModerationConflictError);
    assert.throws(() => store.confirmManualBan({ aid: 42, reason: "No override" }), ModerationConflictError);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("legacy NULL ban source fails closed", () => {
  const { directory, db, store } = fixture();
  try {
    db.prepare("INSERT INTO bans_db.banned_accounts VALUES (42, 10, 10, NULL, 'banned', NULL, 1)").run();
    db.prepare("INSERT INTO bans_db.ban_confirmations (aid, confirmed_at, source, raw_status) VALUES (42, 10, NULL, 'banned')").run();
    const row = store.forAids([42])[0];
    assert.equal(row.banSource, "legacy_unknown");
    assert.equal(row.canRestoreManualBan, false);
    assert.throws(() => store.restoreManualBan({ aid: 42 }), ModerationConflictError);
    assert.throws(() => store.confirmManualBan({ aid: 42, reason: "No override" }), ModerationConflictError);
    assert.ok(db.prepare("SELECT 1 FROM bans_db.banned_accounts WHERE aid = 42").get());
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("ban store exposes legacy NULL provenance as unknown", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = createSqliteBanStore(db);
    db.prepare("INSERT INTO banned_accounts VALUES (42, 10, 10, NULL, 'banned', NULL, 1)").run();
    db.prepare(`INSERT INTO ban_confirmations
      (aid, confirmed_at, source, raw_status) VALUES (42, 10, NULL, 'banned')`).run();
    assert.deepEqual(await store.sources(42), ["legacy_unknown"]);
  } finally { db.close(); }
});

test("legacy audit details are redacted during initialization", () => {
  const { directory, db } = fixture();
  try {
    db.prepare(`INSERT INTO admin_audit_log
      (aid, action, previous_status, next_status, detail, created_at)
      VALUES (42, 'review', 'new', 'reviewed', 'legacy private note', 1)`).run();
    createSqliteModerationStore(db);
    assert.equal(db.prepare("SELECT detail FROM admin_audit_log WHERE aid = 42").get().detail, null);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("manual ban rolls all attached databases back when audit fails", () => {
  const { directory, db, store } = fixture();
  try {
    db.exec(`CREATE TRIGGER fail_ban_audit BEFORE INSERT ON admin_audit_log
      WHEN NEW.action = 'ban' BEGIN SELECT RAISE(ABORT, 'audit failed'); END`);
    assert.throws(() => store.confirmManualBan({ aid: 42, reason: "Evidence" }), /audit failed/);
    assert.equal(db.prepare("SELECT 1 FROM bans_db.banned_accounts WHERE aid = 42").get(), undefined);
    assert.equal(db.prepare("SELECT 1 FROM players_db.excluded_players WHERE aid = 42").get(), undefined);
    assert.equal(db.prepare("SELECT confirmed_banned FROM progression_db.player_profiles WHERE aid = 42").get().confirmed_banned, 0);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("manual ban and restore work with the exclusion databases left in WAL", () => {
  // The sync and publication scripts put players.db and progression.db into WAL
  // on every run, and the mode persists in the file header. WAL participants are
  // not covered by SQLite's super-journal, so the ban cannot be one transaction
  // across them — but the mode must be left exactly as the writers set it.
  const { directory, db, store } = fixture({ walExclusions: true });
  try {
    assert.equal(db.prepare("PRAGMA players_db.journal_mode").get().journal_mode, "wal");
    assert.equal(db.prepare("PRAGMA progression_db.journal_mode").get().journal_mode, "wal");
    assert.equal(db.prepare("PRAGMA bans_db.journal_mode").get().journal_mode, "delete");

    store.confirmManualBan({ aid: 42, reason: "Manual evidence", now: 40 });
    assert.ok(db.prepare("SELECT 1 FROM bans_db.banned_accounts WHERE aid = 42").get());
    assert.ok(db.prepare("SELECT 1 FROM players_db.excluded_players WHERE aid = 42").get());
    assert.ok(db.prepare("SELECT 1 FROM progression_db.excluded_players WHERE aid = 42").get());
    assert.equal(db.prepare("SELECT confirmed_banned FROM progression_db.player_profiles WHERE aid = 42").get().confirmed_banned, 1);
    assert.equal(store.forAids([42])[0].canRestoreManualBan, true);

    store.restoreManualBan({ aid: 42, now: 50 });
    assert.equal(db.prepare("SELECT 1 FROM players_db.excluded_players WHERE aid = 42").get(), undefined);
    assert.equal(db.prepare("SELECT 1 FROM progression_db.excluded_players WHERE aid = 42").get(), undefined);
    assert.equal(db.prepare("SELECT confirmed_banned FROM progression_db.player_profiles WHERE aid = 42").get().confirmed_banned, 0);
    assert.equal(db.prepare("PRAGMA players_db.journal_mode").get().journal_mode, "wal");
    assert.equal(db.prepare("PRAGMA progression_db.journal_mode").get().journal_mode, "wal");
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a ban killed between its record commit and its exclusions is completed on the next init", () => {
  // confirmManualBan commits the ban record, the review and the audit entry
  // first, then the tombstones the public queries read. The second commit is not
  // atomic with the first, so a hard kill in between leaves exactly the state
  // reproduced here: the ban is on record with an audit trail, the exclusions
  // are not applied yet.
  const { directory, db, store } = fixture({ walExclusions: true });
  try {
    store.confirmManualBan({ aid: 42, reason: "Manual evidence", now: 40 });
    db.prepare("DELETE FROM players_db.excluded_players WHERE aid = 42").run();
    db.prepare("DELETE FROM progression_db.excluded_players WHERE aid = 42").run();
    db.prepare("UPDATE progression_db.player_profiles SET confirmed_banned = 0 WHERE aid = 42").run();

    assert.ok(db.prepare("SELECT 1 FROM bans_db.banned_accounts WHERE aid = 42").get(), "the record survived");
    assert.deepEqual(db.prepare("SELECT action FROM admin_audit_log ORDER BY id").all().map((row) => row.action), ["ban"]);
    assert.equal(store.forAids([42])[0].canRestoreManualBan, true);
    assert.equal(db.prepare("SELECT 1 FROM players_db.excluded_players WHERE aid = 42").get(), undefined);

    createSqliteModerationStore(db);
    assert.ok(db.prepare("SELECT 1 FROM players_db.excluded_players WHERE aid = 42").get(), "the exclusion is applied");
    assert.ok(db.prepare("SELECT 1 FROM progression_db.excluded_players WHERE aid = 42").get());
    assert.equal(db.prepare("SELECT confirmed_banned FROM progression_db.player_profiles WHERE aid = 42").get().confirmed_banned, 1);
    // Derived state only: the repair adds no second ban, review or audit entry.
    assert.equal(db.prepare("SELECT COUNT(*) n FROM bans_db.ban_confirmations").get().n, 1);
    assert.deepEqual(db.prepare("SELECT action, previous_status, next_status FROM admin_audit_log ORDER BY id").all()
      .map((row) => ({ ...row })), [{ action: "ban", previous_status: "new", next_status: "confirmed" }]);
    // A banned account must never be backfilled as unknown upstream provenance,
    // which would make it unrestorable.
    assert.equal(db.prepare("SELECT 1 FROM progression_db.upstream_ban_confirmations WHERE aid = 42").get(), undefined);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a restore killed after the record is deleted drops the leftover exclusion", () => {
  // restoreManualBan drops the ban record first, so a hard kill in between leaves
  // the reverse tear: an admin_manual tombstone with no ban. That state used to
  // hide the account from every statistic with nothing left to restore.
  const { directory, db, store } = fixture({ walExclusions: true });
  try {
    store.confirmManualBan({ aid: 42, reason: "Manual evidence", now: 40 });
    db.prepare("DELETE FROM bans_db.banned_accounts WHERE aid = 42").run();
    db.prepare("DELETE FROM bans_db.ban_confirmations WHERE aid = 42").run();

    createSqliteModerationStore(db);
    assert.equal(db.prepare("SELECT 1 FROM players_db.excluded_players WHERE aid = 42").get(), undefined);
    assert.equal(db.prepare("SELECT 1 FROM progression_db.excluded_players WHERE aid = 42").get(), undefined);
    assert.equal(db.prepare("SELECT confirmed_banned FROM progression_db.player_profiles WHERE aid = 42").get().confirmed_banned, 0);
    assert.equal(store.forAids([42])[0].sources.confirmedBan, false);
    assert.equal(store.forAids([42])[0].canRestoreManualBan, false);
    // The admin_manual tombstone is the only thing removed, and only with no ban
    // record left anywhere to justify it.
    store.confirmManualBan({ aid: 42, reason: "Manual evidence", now: 60 });
    db.prepare("UPDATE progression_db.player_profiles SET confirmed_banned = 0 WHERE aid = 42").run();
    createSqliteModerationStore(db);
    assert.ok(db.prepare("SELECT 1 FROM players_db.excluded_players WHERE aid = 42").get());
    assert.equal(db.prepare("SELECT confirmed_banned FROM progression_db.player_profiles WHERE aid = 42").get().confirmed_banned, 1);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("an upstream ban keeps the exclusion the reconciliation would otherwise call orphaned", () => {
  // The tombstone is derived from the ban record, so a ban whose provenance lives
  // only in progression_db still has to keep the account out of the leaderboards.
  const { directory, db, store } = fixture({ walExclusions: true });
  try {
    db.prepare(`INSERT INTO progression_db.upstream_ban_confirmations
      (aid, mode, cycle_id, source, confirmed_at) VALUES (42, 'seasonal', 's1', 'seasonal_upstream', 10)`).run();
    db.prepare("INSERT INTO progression_db.excluded_players VALUES (42, 'admin_manual', 10)").run();
    db.prepare("INSERT INTO players_db.excluded_players VALUES (42, 'admin_manual', 10)").run();
    createSqliteModerationStore(db);
    assert.ok(db.prepare("SELECT 1 FROM players_db.excluded_players WHERE aid = 42").get());
    assert.ok(db.prepare("SELECT 1 FROM progression_db.excluded_players WHERE aid = 42").get());
    assert.equal(store.forAids([42])[0].banSource, "seasonal_upstream");
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("a bans database left in WAL is refused instead of silently losing the audit trail", () => {
  const { directory, db } = fixture();
  try {
    db.exec("DETACH DATABASE bans_db");
    const bans = new DatabaseSync(process.env.BANS_SQLITE_PATH);
    bans.exec("PRAGMA journal_mode = WAL");
    bans.close();
    assert.throws(() => createSqliteModerationStore(db), /bans_db database must use a rollback journal/);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("Seasonal banned profiles retain personal snapshots and their exclusion flag", async () => {
  const db = new DatabaseSync(":memory:");
  const store = createSqliteSeasonalStore(db);
  db.prepare("INSERT INTO excluded_players VALUES (42, 'admin_manual', 1)").run();
  const profile = {
    mode: "seasonal", cycleId: "s1", aid: 42, nickname: "Retained",
    profileUpdatedAt: 100, lastAccessAt: 100, lifetimePvpHours: 500,
    counters: { experience: 1, pmcRaids: 1, scavRaids: 0, pmcSurvived: 1,
      pmcDeaths: 0, pmcKills: 1, killedPmc: 1 },
  };
  const stored = await store.upsertProfile(profile);
  assert.equal(stored.confirmedBanned, true);
  assert.equal((await store.captureSnapshot(profile)).status, "baseline");
  assert.equal((await store.captureSnapshot(profile)).status, "duplicate");
  assert.equal(db.prepare("SELECT nickname FROM player_profiles WHERE aid = 42").get().nickname, "Retained");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM progression_snapshots").get().n, 1);
  assert.equal(db.prepare("SELECT confirmed_banned FROM player_profiles WHERE aid = 42").get().confirmed_banned, 1);
  db.close();
});

test("regular progression materializes personal history while preserving the exclusion flag", () => {
  const db = new DatabaseSync(":memory:");
  createSqliteSeasonalStore(db);
  db.prepare("INSERT INTO excluded_players VALUES (42, 'admin_manual', 1)").run();
  db.prepare(`INSERT INTO progression_snapshots
    (mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at, local_date,
      nickname, achievements, stats_json)
    VALUES ('regular', 'persistent', 42, 100, 100, 100, '2026-01-01', 'Kept', '[]', ?)`)
    .run(JSON.stringify({ nickname: "Kept", hoursPlayed: 100, experience: 1, pmcRaids: 1,
      scavRaids: 0, pmcSurvived: 1, pmcDeaths: 0, pmcKills: 1, killedPmc: 1 }));
  materializeRegularProgression(db);
  assert.equal(db.prepare("SELECT confirmed_banned FROM player_profiles WHERE aid = 42").get().confirmed_banned, 1);
  assert.equal(db.prepare("SELECT 1 FROM progression_snapshots WHERE aid = 42").get() != null, true);
  db.close();
});

// confirmBanned spans three attached databases in one transaction, so these
// tests need three real files rather than :memory:.
function banArchiveFixture() {
  const directory = mkdtempSync(join(tmpdir(), "ban-archive-"));
  const bansPath = join(directory, "bans.db");
  const previous = {
    bans: process.env.BANS_SQLITE_PATH,
    players: process.env.SQLITE_PATH,
    progression: process.env.PROGRESSION_SQLITE_PATH,
  };
  process.env.BANS_SQLITE_PATH = bansPath;
  process.env.SQLITE_PATH = join(directory, "players.db");
  process.env.PROGRESSION_SQLITE_PATH = join(directory, "progression.db");
  const progression = new DatabaseSync(process.env.PROGRESSION_SQLITE_PATH);
  // Called for its schema side effect only: createSqliteSeasonalStore takes the
  // database and nothing else, and the returned store is not used here.
  createSqliteSeasonalStore(progression);
  return {
    progression,
    openBans: () => new DatabaseSync(bansPath),
    cleanup() {
      progression.close();
      rmSync(directory, { recursive: true, force: true });
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

// Every column the upstream payload omits stays NULL, exactly as the store
// writes the rows.
function insertProgressionRow(db, { mode, cycleId, aid, at, nickname }) {
  db.prepare(`INSERT INTO progression_snapshots
    (mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at, local_date, series_id, nickname, side)
    VALUES (?, ?, ?, ?, ?, ?, '2026-01-01', 1, ?, 'Usec')`)
    .run(mode, cycleId, aid, at, at, at, nickname);
}

// A complete confirmation. Every value the archive binds is present, so a
// rejected ban can only come from the archive step or from a field a test
// deliberately drops.
function confirmationInput(aid, at, nickname) {
  return { aid, upstreamUpdatedAt: at, capturedAt: at,
    stats: { nickname, side: "Usec", prestige: null, level: null, experience: 100,
      hoursPlayed: null, totalRaids: null, pmcRaids: 5, scavRaids: 0, survivedRaids: null,
      deaths: null, pmcDeaths: 0, totalKills: null, killedPmc: 0, runThrough: null,
      longestWinStreak: null, achievementsCount: null },
    achievementIds: [] };
}

test("ban confirmation archives the full progression history before deleting it", async () => {
  // progression_snapshots keeps prestige/level/hours/total_raids/... nullable
  // while banned_snapshots declares them NOT NULL. With INSERT OR IGNORE the
  // violation was swallowed, so the archive stayed empty and the source rows
  // were deleted anyway.
  const { progression, openBans, cleanup } = banArchiveFixture();
  insertProgressionRow(progression, { mode: "seasonal", cycleId: "s1", aid: 42, at: 1_000, nickname: "Old" });
  insertProgressionRow(progression, { mode: "seasonal", cycleId: "s1", aid: 42, at: 1_500, nickname: "Old" });
  assert.equal(
    progression.prepare("SELECT COUNT(*) AS n FROM progression_snapshots WHERE aid = 42").get().n, 2);

  try {
    const db = openBans();
    try {
      const store = createSqliteBanStore(db);
      await store.confirmBanned(confirmationInput(42, 2_000, "New"), { source: "upstream", confirmedAt: 5_000 });

      // Both historical rows plus the confirmation are preserved.
      const archived = db.prepare(
        "SELECT upstream_updated_at, nickname FROM banned_snapshots WHERE aid = 42 ORDER BY upstream_updated_at",
      ).all().map((row) => ({ ...row }));
      assert.deepEqual(archived, [
        { upstream_updated_at: 1_000, nickname: "Old" },
        { upstream_updated_at: 1_500, nickname: "Old" },
        { upstream_updated_at: 2_000, nickname: "New" },
      ]);
      // The NULL source columns were normalised, not dropped.
      assert.deepEqual({ ...db.prepare(
        "SELECT total_raids, prestige, achievements FROM banned_snapshots WHERE aid = 42 AND upstream_updated_at = 1000",
      ).get() }, { total_raids: 0, prestige: 0, achievements: "[]" });
    } finally { db.close(); }

    // The source history is only deleted because the archive now holds it.
    assert.equal(
      progression.prepare("SELECT COUNT(*) AS n FROM progression_snapshots WHERE aid = 42").get().n, 0);
  } finally { cleanup(); }
});

test("ban confirmation rolls back when a stat the payload never reported is missing", async () => {
  // Normalising NULL must not extend to a missing field. `undefined` fails the
  // bind, and the ban has to roll back rather than commit a snapshot padded
  // with zeroes the upstream payload never reported. History is present here so
  // the rollback has to undo the archive insert and leave the source alone.
  const { progression, openBans, cleanup } = banArchiveFixture();
  insertProgressionRow(progression, { mode: "seasonal", cycleId: "s1", aid: 43, at: 2_500, nickname: "Old" });
  const db = openBans();
  try {
    const store = createSqliteBanStore(db);
    await assert.rejects(store.confirmBanned({ aid: 43, upstreamUpdatedAt: 3_000, capturedAt: 3_000,
      stats: { nickname: "Partial", side: "Usec", experience: 1 },
      achievementIds: [] }, { source: "upstream", confirmedAt: 6_000 }));
    // The archive insert ran before the failing bind, so the rollback has to
    // undo it, and the source delete below it never survives either.
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM banned_snapshots WHERE aid = 43").get().n, 0);
    assert.equal(db.prepare("SELECT 1 FROM banned_accounts WHERE aid = 43").get(), undefined);
    assert.equal(
      progression.prepare("SELECT COUNT(*) AS n FROM progression_snapshots WHERE aid = 43").get().n, 1);
  } finally { db.close(); cleanup(); }
});

test("ban confirmation refuses to delete history the archive key cannot hold", async () => {
  // The source is UNIQUE(mode, cycle_id, aid, profile_updated_at) and the
  // archive is UNIQUE(aid, upstream_updated_at), so the regular and pve reads of
  // one profile.updated collide on the copy and INSERT OR IGNORE keeps only the
  // first. Deleting the source then loses the pve row for good.
  const { progression, openBans, cleanup } = banArchiveFixture();
  insertProgressionRow(progression, { mode: "regular", cycleId: "persistent", aid: 44, at: 1_000, nickname: "Old" });
  insertProgressionRow(progression, { mode: "pve", cycleId: "persistent", aid: 44, at: 1_000, nickname: "Old" });
  insertProgressionRow(progression, { mode: "seasonal", cycleId: "s1", aid: 44, at: 2_000, nickname: "Old" });
  const db = openBans();
  try {
    const store = createSqliteBanStore(db);
    await assert.rejects(
      store.confirmBanned(confirmationInput(44, 3_000, "New"), { source: "upstream", confirmedAt: 7_000 }),
      /archive incomplete for aid 44: 2 of 3 rows archived/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM banned_snapshots WHERE aid = 44").get().n, 0);
    assert.equal(db.prepare("SELECT 1 FROM banned_accounts WHERE aid = 44").get(), undefined);
    assert.equal(
      progression.prepare("SELECT COUNT(*) AS n FROM progression_snapshots WHERE aid = 44").get().n, 3);
  } finally { db.close(); cleanup(); }
});

test("ban confirmation keeps the archive when the WAL exclusion phase fails", async () => {
  // confirmBanned commits the confirmation and the whole archive in bans.db
  // first, then the exclusions and row deletions in the two WAL databases. A
  // kill or a failure between them must leave the archive and the ban record
  // standing and the source rows untouched, never the reverse.
  const { progression, openBans, cleanup } = banArchiveFixture();
  insertProgressionRow(progression, { mode: "seasonal", cycleId: "s1", aid: 46, at: 1_000, nickname: "Old" });
  progression.exec("PRAGMA journal_mode = WAL");
  progression.exec(`CREATE TRIGGER fail_exclusions BEFORE DELETE ON progression_snapshots
    BEGIN SELECT RAISE(ABORT, 'exclusion phase failed'); END`);
  const db = openBans();
  try {
    const store = createSqliteBanStore(db);
    await assert.rejects(
      store.confirmBanned(confirmationInput(46, 2_000, "New"), { source: "upstream", confirmedAt: 9_000 }),
      /exclusion phase failed/);
    assert.ok(db.prepare("SELECT 1 FROM banned_accounts WHERE aid = 46").get());
    assert.ok(db.prepare("SELECT 1 FROM banned_snapshots WHERE aid = 46 AND upstream_updated_at = 1000").get());
    assert.equal(progression.prepare("SELECT COUNT(*) AS n FROM progression_snapshots WHERE aid = 46").get().n, 1);
    assert.equal(db.prepare("SELECT 1 FROM players_db.excluded_players WHERE aid = 46").get(), undefined);

    // The next upstream confirmation of the same banned profile finishes the job.
    progression.exec("DROP TRIGGER fail_exclusions");
    await store.confirmBanned(confirmationInput(46, 2_000, "New"), { source: "upstream", confirmedAt: 10_000 });
    assert.ok(db.prepare("SELECT 1 FROM players_db.excluded_players WHERE aid = 46").get());
    assert.equal(progression.prepare("SELECT COUNT(*) AS n FROM progression_snapshots WHERE aid = 46").get().n, 0);
  } finally { db.close(); cleanup(); }
});

test("ban confirmation rolls back instead of archiving an empty achievement list", async () => {
  // An archived "[]" is indistinguishable from a player with no achievements,
  // so a missing list has to fail the bind like every other missing value.
  const { progression, openBans, cleanup } = banArchiveFixture();
  insertProgressionRow(progression, { mode: "seasonal", cycleId: "s1", aid: 45, at: 1_000, nickname: "Old" });
  const input = confirmationInput(45, 2_000, "New");
  delete input.achievementIds;
  const db = openBans();
  try {
    const store = createSqliteBanStore(db);
    await assert.rejects(
      store.confirmBanned(input, { source: "upstream", confirmedAt: 8_000 }));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM banned_snapshots WHERE aid = 45").get().n, 0);
    assert.equal(db.prepare("SELECT 1 FROM banned_accounts WHERE aid = 45").get(), undefined);
    assert.equal(
      progression.prepare("SELECT COUNT(*) AS n FROM progression_snapshots WHERE aid = 45").get().n, 1);
  } finally { db.close(); cleanup(); }
});
