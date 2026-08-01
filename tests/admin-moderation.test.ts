/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- node:sqlite types are not present in the project's Node 20 type package.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createSqliteModerationStore, ModerationConflictError } from "../lib/admin/moderation-db.ts";
import { createSqliteBanStore } from "../lib/ban-db.ts";
import { createSqliteSeasonalStore } from "../lib/seasonal/storage.ts";
import { materializeRegularProgression } from "../lib/regular-progression.ts";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "admin-moderation-"));
  process.env.BANS_SQLITE_PATH = join(directory, "bans.db");
  process.env.SQLITE_PATH = join(directory, "players.db");
  process.env.PROGRESSION_SQLITE_PATH = join(directory, "progression.db");
  process.env.REPORTS_SQLITE_PATH = join(directory, "reports.db");
  const players = new DatabaseSync(process.env.SQLITE_PATH);
  players.exec("CREATE TABLE players (aid INTEGER PRIMARY KEY, nickname TEXT); INSERT INTO players VALUES (42, 'Kept');");
  players.close();
  const progression = new DatabaseSync(process.env.PROGRESSION_SQLITE_PATH);
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

test("Seasonal upserts and snapshots honor a global tombstone without deleting the profile", async () => {
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
  assert.equal((await store.captureSnapshot(profile)).status, "banned");
  assert.equal(db.prepare("SELECT nickname FROM player_profiles WHERE aid = 42").get().nickname, "Retained");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM progression_snapshots").get().n, 0);
  db.close();
});

test("regular progression materialization excludes tombstoned snapshots", () => {
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
  assert.equal(db.prepare("SELECT 1 FROM player_profiles WHERE aid = 42").get(), undefined);
  assert.equal(db.prepare("SELECT 1 FROM progression_snapshots WHERE aid = 42").get() != null, true);
  db.close();
});
