/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- node:sqlite types are absent from the supported Node 20 type package.
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  materializeAchievementBaseline,
  readPublishedAchievementBaseline,
} from "../lib/achievement-baseline-publication.ts";

function fixture(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE players (aid INTEGER PRIMARY KEY, hours REAL, achievements TEXT);
    CREATE TABLE mode_players (mode TEXT, aid INTEGER, hours REAL, achievements TEXT);
    CREATE TABLE excluded_players (aid INTEGER PRIMARY KEY);
    INSERT INTO players VALUES
      (1, 10, '["a","b"]'), (2, 20, '["a"]'), (3, 30, '["b"]'), (9, 1, '["a"]');
    INSERT INTO mode_players VALUES
      ('pve', 1, 100, '["a"]'), ('pve', 4, 200, '["c"]'), ('arena', 5, 1, '["x"]');
    INSERT INTO excluded_players VALUES (9);
  `);
  return db;
}

test("achievement baseline publishes PVP and PvE independently", () => {
  const db = fixture();
  const regular = materializeAchievementBaseline(db, "regular", 1_000);
  const pve = materializeAchievementBaseline(db, "pve", 2_000);

  assert.equal(regular.total, 3);
  assert.deepEqual(regular.achievements.map((row) => [row.ach_id, row.owners]), [["a", 2], ["b", 2]]);
  assert.equal(pve.total, 2);
  assert.deepEqual(pve.achievements.map((row) => [row.ach_id, row.owners]), [["a", 1], ["c", 1]]);
  assert.equal(readPublishedAchievementBaseline(db, "regular")?.generation, 1_000);
  assert.equal(readPublishedAchievementBaseline(db, "pve")?.generation, 2_000);
  db.close();
});

test("missing and corrupt achievement publications degrade to null", () => {
  const db = fixture();
  materializeAchievementBaseline(db, "regular", 1_000);
  assert.equal(readPublishedAchievementBaseline(db, "pve"), null);
  db.prepare("UPDATE achievement_baseline_publications SET achievements_json = 'broken' WHERE mode = 'regular'").run();
  assert.equal(readPublishedAchievementBaseline(db, "regular"), null);
  db.close();
});

test("failed publication preserves the previous generation", () => {
  const db = fixture();
  materializeAchievementBaseline(db, "regular", 1_000);
  db.exec(`CREATE TRIGGER reject_baseline_update BEFORE UPDATE ON achievement_baseline_publications
    WHEN OLD.mode = 'regular' BEGIN SELECT RAISE(ABORT, 'reject'); END;`);
  assert.throws(() => materializeAchievementBaseline(db, "regular", 2_000), /reject/);
  assert.equal(readPublishedAchievementBaseline(db, "regular")?.generation, 1_000);
  db.close();
});
