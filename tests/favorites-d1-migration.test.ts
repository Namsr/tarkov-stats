/* eslint-disable @typescript-eslint/ban-ts-comment */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// @ts-ignore -- Node 24 exposes node:sqlite at runtime; project types target Node 20.
import { DatabaseSync } from "node:sqlite";

const migration = readFileSync("scripts/favorites-d1.sql", "utf8");

function columns(db: DatabaseSync): string[] {
  return (db.prepare("PRAGMA table_info(favorites)").all() as { name: string }[])
    .map((row) => row.name);
}

test("favorites D1 migration creates the composite schema on a fresh database", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(migration);

  assert.ok(columns(db).includes("mode"));
  assert.ok(columns(db).includes("cycle_id"));
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'favorites_legacy'").get(), undefined);
  db.prepare(`INSERT INTO favorites
    (user_sub, mode, cycle_id, aid, nickname, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run("user-1", "seasonal", "season-a", 42, "Fresh", 100);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM favorites").get() as { n: number }).n, 1);
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
