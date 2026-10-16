import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  materializeAchievementBaseline,
  readPublishedAchievementBaseline,
  readRegularRiskAchievementBaseline,
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

test("display unlock hours use P5 below 500 owners and P1 from 500 owners", () => {
  const db = fixture();
  const insert = db.prepare("INSERT INTO players (aid, hours, achievements) VALUES (?, ?, ?)");
  for (let aid = 10; aid < 509; aid += 1) insert.run(aid, aid - 9, '["small","large"]');
  insert.run(509, 500, '["large"]');

  const baseline = materializeAchievementBaseline(db, "regular", 3_000);
  const small = baseline.achievements.find((row) => row.ach_id === "small");
  const large = baseline.achievements.find((row) => row.ach_id === "large");

  assert.equal(small?.owners, 499);
  assert.equal(small?.unlockHours, 25);
  assert.equal(large?.owners, 500);
  assert.equal(large?.unlockHours, 5);
  assert.ok((large?.earlyHours ?? 0) > (large?.unlockHours ?? 0));
  db.close();
});

test("legacy publications use early hours as the display fallback", () => {
  const db = fixture();
  materializeAchievementBaseline(db, "regular", 1_000);
  const publication = readPublishedAchievementBaseline(db, "regular");
  const legacy = publication!.achievements.map((achievement) => ({
    ach_id: achievement.ach_id,
    owners: achievement.owners,
    meanHours: achievement.meanHours,
    stdHours: achievement.stdHours,
    earlyHours: achievement.earlyHours,
  }));
  db.prepare("UPDATE achievement_baseline_publications SET achievements_json = ? WHERE mode = 'regular'")
    .run(JSON.stringify(legacy));

  const parsed = readPublishedAchievementBaseline(db, "regular");
  assert.equal(parsed?.achievements[0]?.unlockHours, parsed?.achievements[0]?.earlyHours);
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

test("a zero-hour achievement owner is not replaced by the mean", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE players (aid INTEGER PRIMARY KEY, hours REAL, achievements TEXT);
      CREATE TABLE excluded_players (aid INTEGER PRIMARY KEY);`);
    const insert = db.prepare("INSERT INTO players (aid, hours, achievements) VALUES (?, ?, ?)");
    // Five owners: one with zero playtime, four with 100 hours. owners=5 makes
    // the P5 rank (5+4)/5 = 1, which lands exactly on the 0-hour row.
    insert.run(1, 0, '["mixed"]');
    for (let aid = 2; aid <= 5; aid += 1) insert.run(aid, 100, '["mixed"]');

    const baseline = materializeAchievementBaseline(db, "regular", 1_000);
    const mixed = baseline.achievements.find((row) => row.ach_id === "mixed");
    assert.equal(mixed?.meanHours, 80);
    // `Number(x) || mean` published 80 here: a real 0 is not a missing value.
    assert.equal(mixed?.earlyHours, 0);
    assert.equal(mixed?.unlockHours, 0);
  } finally { db.close(); }
});

test("an unresolved percentile rank still falls back to the mean", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE players (aid INTEGER PRIMARY KEY, hours REAL, achievements TEXT);
      CREATE TABLE excluded_players (aid INTEGER PRIMARY KEY);`);
    const insert = db.prepare("INSERT INTO players (aid, hours, achievements) VALUES (?, ?, ?)");
    // Two owners, no usable hours on the first: SQLite sorts NULL first, so it
    // takes rank 1 and both percentile columns resolve to NULL.
    insert.run(1, null, '["gapped"]');
    insert.run(2, 100, '["gapped"]');

    const baseline = materializeAchievementBaseline(db, "regular", 1_000);
    const gapped = baseline.achievements.find((row) => row.ach_id === "gapped");
    assert.equal(gapped?.owners, 2);
    assert.equal(gapped?.meanHours, 100);
    // Without the mean fallback these publish 0, which reads as "unlocked at 0h".
    assert.equal(gapped?.earlyHours, 100);
    assert.equal(gapped?.unlockHours, 100);
  } finally { db.close(); }
});

test("risk achievement tombstone membership preserves exact moments, owner order and p20", () => {
  const db = fixture();
  try {
    materializeAchievementBaseline(db, "regular", 1);
    db.prepare("INSERT INTO regular_risk_achievement_owners VALUES (999,'a',0.1)").run();
    const owner = db.prepare("INSERT INTO regular_risk_achievement_owners VALUES (?,'fractional',?)");
    const player = db.prepare("INSERT INTO players VALUES (?,?,'[]')");
    for (let i = 10; i < 511; i++) {
      const hours = i % 13 / 7;
      player.run(i, hours); owner.run(i, hours);
    }
    db.exec("DELETE FROM players WHERE aid=11; INSERT INTO excluded_players VALUES (12)");
    const where = `WHERE ach_id=? AND aid!=? AND hours>0 AND hours<1e100
      AND EXISTS(SELECT 1 FROM players p INDEXED BY idx_players_risk_identity WHERE p.aid=regular_risk_achievement_owners.aid)
      AND NOT EXISTS(SELECT 1 FROM excluded_players e WHERE e.aid=regular_risk_achievement_owners.aid)`;
    const agg = db.prepare(`SELECT COUNT(*) n, AVG(hours) mean, AVG(hours*hours) square FROM regular_risk_achievement_owners ${where}`);
    const rank = db.prepare(`SELECT hours FROM regular_risk_achievement_owners ${where} ORDER BY hours,aid LIMIT 1 OFFSET ?`);
    for (const aid of [1, 9, 11, 12, 999999]) {
      const ids = ["fractional", "a", "absent", "fractional"];
      const expected = [...new Set(ids)].map((id) => {
        const row = agg.get(id, aid)!;
        const n = Number(row.n); const mean = Number(row.mean ?? 0);
        const p20 = n ? Number(rank.get(id, aid, Math.ceil(n * 0.2) - 1)?.hours ?? 0) : 0;
        return { ach_id: id, owners: n, hoursOwners: n, meanHours: mean,
          stdHours: Math.sqrt(Math.max(0, Number(row.square ?? 0) - mean * mean)), earlyHours: p20, unlockHours: p20 };
      });
      const actual = readRegularRiskAchievementBaseline(db, ids, aid);
      assert.deepEqual(actual.achievements, expected);
      assert.equal(actual.total, 2);
    }
  } finally { db.close(); }
});

test("risk owner diagnostics separate SQL passes without changing results or exposing identities", () => {
  const db = fixture();
  try {
    materializeAchievementBaseline(db, "regular", 1);
    const events: Record<string, unknown>[] = [];
    const actual = readRegularRiskAchievementBaseline(db, ["a", "a", "b"], 1, (event) => events.push({ ...event }));
    const expected = readRegularRiskAchievementBaseline(db, ["a", "b"], 1, () => { throw new Error("logger unavailable"); });
    assert.deepEqual(actual, expected);
    assert.equal(events.length, 1);
    assert.equal(events[0].requestedIds, 2);
    assert.equal(events[0].referenceAvailable, true);
    assert.equal(events[0].outcome, "success");
    assert.ok(Number(events[0].aggregateMs) >= 0);
    assert.ok(Number(events[0].percentileMs) >= 0);
    assert.ok(Number(events[0].totalMs) >= 0);
    assert.equal("aid" in events[0], false);
    assert.equal("ownedIds" in events[0], false);
    const serialized: string[] = [];
    readRegularRiskAchievementBaseline(db, ["private-achievement-slug-unique"], 987654321,
      (event) => serialized.push(JSON.stringify(event)));
    assert.equal(serialized.length, 1);
    assert.ok(!serialized[0].includes("private-achievement-slug-unique"));
    assert.ok(!serialized[0].includes("987654321"));
    const error = new Error("storage unavailable");
    assert.throws(() => readRegularRiskAchievementBaseline({ prepare() { throw error; } }, ["a"], 1,
      (event) => events.push({ ...event })), (caught) => caught === error);
    assert.equal(events[1].outcome, "error");
  } finally { db.close(); }
});
