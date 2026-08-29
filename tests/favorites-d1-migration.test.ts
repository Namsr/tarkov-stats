/* eslint-disable @typescript-eslint/ban-ts-comment */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// @ts-ignore -- Node 24 exposes node:sqlite at runtime; project types target Node 20.
import { DatabaseSync } from "node:sqlite";

const migration = readFileSync("scripts/favorites-d1.sql", "utf8");
const globalAidMigration = readFileSync("migrations/0001_favorites_global_aid.sql", "utf8");

function columns(db: DatabaseSync): string[] {
  return (db.prepare("PRAGMA table_info(favorites)").all() as { name: string }[])
    .map((row) => row.name);
}

test("the already-applied favorites D1 migration keeps its identity-scoped key", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(migration);

  assert.ok(columns(db).includes("mode"));
  assert.ok(columns(db).includes("cycle_id"));
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'favorites_legacy'").get(), undefined);
  db.prepare(`INSERT INTO favorites
    (user_sub, mode, cycle_id, aid, nickname, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run("user-1", "seasonal", "season-a", 42, "Fresh", 100);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM favorites").get() as { n: number }).n, 1);
  db.prepare(`INSERT INTO favorites
    (user_sub, mode, cycle_id, aid, nickname, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run("user-1", "regular", "persistent", 42, "Duplicate", 200);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM favorites").get() as { n: number }).n, 2);
});

test("favorites D1 migration preserves legacy rows as regular/persistent", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE favorites (
    user_sub TEXT NOT NULL,
    aid INTEGER NOT NULL,
    nickname TEXT,
    note TEXT,
    is_main INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_sub, aid)
  );
  CREATE INDEX idx_favorites_user ON favorites(user_sub);
  INSERT INTO favorites VALUES ('user-1', 42, 'Legacy', 'note', 1, 100);`);

  db.exec(migration);

  const row = db.prepare(`SELECT mode, cycle_id, aid, nickname, note, is_main, created_at
    FROM favorites WHERE user_sub = 'user-1'`).get();
  assert.deepEqual({ ...row }, {
    mode: "regular", cycle_id: "persistent", aid: 42, nickname: "Legacy",
    note: "note", is_main: 1, created_at: 100,
  });
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'favorites_legacy'").get(), undefined);
  db.prepare(`INSERT INTO favorites
      (user_sub, mode, cycle_id, aid, nickname, created_at)
      VALUES ('user-1', 'seasonal', 'season-a', 42, 'Seasonal', 200)`).run();
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM favorites").get() as { n: number }).n, 2);
});

test("global AID D1 migration deterministically merges existing identity duplicates", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE favorites (
    user_sub TEXT NOT NULL, mode TEXT NOT NULL, cycle_id TEXT NOT NULL, aid INTEGER NOT NULL,
    nickname TEXT, note TEXT, is_main INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
    PRIMARY KEY (user_sub, mode, cycle_id, aid));
    INSERT INTO favorites VALUES ('user-1', 'regular', 'persistent', 42, 'Regular', 'note', 0, 100);
    INSERT INTO favorites VALUES ('user-1', 'seasonal', 'season-a', 42, 'Seasonal', NULL, 1, 200);
    INSERT INTO favorites VALUES ('user-1', 'arena', 'persistent', 43, 'Other', NULL, 1, 250);`);

  db.exec(globalAidMigration);

  const row = db.prepare("SELECT * FROM favorites WHERE aid = 42").get();
  assert.deepEqual({ ...row }, {
    user_sub: "user-1", mode: "regular", cycle_id: "persistent", aid: 42,
    nickname: "Seasonal", note: "note", is_main: 0, created_at: 100,
  });
  assert.throws(() => db.prepare(`INSERT INTO favorites VALUES
    ('user-1', 'arena', 'persistent', 42, NULL, NULL, 0, 300)`).run(), /UNIQUE constraint failed/);
  assert.deepEqual(
    db.prepare("SELECT aid FROM favorites WHERE user_sub = 'user-1' AND is_main = 1").all()
      .map((entry: { aid: number }) => Number(entry.aid)),
    [43],
  );
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'favorites_global'").get(), undefined);
});
