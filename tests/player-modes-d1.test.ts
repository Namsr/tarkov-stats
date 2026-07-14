/* eslint-disable @typescript-eslint/ban-ts-comment */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// @ts-ignore -- Node 24 exposes node:sqlite at runtime; project types target Node 20.
import { DatabaseSync } from "node:sqlite";

const migration = readFileSync("scripts/player-modes-d1.sql", "utf8");

test("PVE and Arena rows remain isolated for the same account", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(migration);
  const insert = db.prepare(`INSERT INTO mode_players
    (mode, aid, nickname, fetched_at, stats_json, achievements)
    VALUES (?, ?, ?, ?, ?, ?)`);

  insert.run("pve", 42, "PVE profile", 1, '{"nickname":"PVE profile"}', "[]");
  insert.run("arena", 42, "Arena profile", 1, '{"nickname":"Arena profile"}', "[]");

  assert.equal(
    (db.prepare("SELECT nickname FROM pve_players WHERE aid = 42").get() as { nickname: string }).nickname,
    "PVE profile",
  );
  assert.equal(
    (db.prepare("SELECT nickname FROM arena_players WHERE aid = 42").get() as { nickname: string }).nickname,
    "Arena profile",
  );
  assert.throws(() => insert.run("regular", 42, "Bad", 1, "{}", "[]"));
});
