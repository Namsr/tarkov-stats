import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const execFileAsync = promisify(execFile);

function launch(dbPath, url, ...args) {
  return execFileAsync(process.execPath, [
    "--experimental-strip-types",
    "--experimental-sqlite",
    "scripts/sync-pve-index.mjs",
    "--db",
    dbPath,
    "--url",
    url,
    ...args,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
}

test("PvE index validates a streamed payload and swaps it atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pve-index-sync-"));
  const dbPath = join(directory, "players.db");
  let payload = JSON.stringify({
    "42": "Valid_Player",
    "43": "Second",
    "0": "Zero",
    "-2": "Negative",
    nope: "BadAid",
    "44": "bad nickname!",
    "45": "",
    "46": "Third",
    "47": "Fourth",
  });
  let etag = '"pve-v1"';
  let lastModified = "Sun, 23 Aug 2026 12:00:00 GMT";
  const requests = [];
  const server = createServer(async (request, response) => {
    requests.push({
      etag: request.headers["if-none-match"] ?? null,
      lastModified: request.headers["if-modified-since"] ?? null,
    });
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304);
      response.end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.setHeader("etag", etag);
    response.setHeader("last-modified", lastModified);
    for (const character of payload) response.write(character);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/pve/index.json`;

  try {
    const first = await launch(dbPath, url);
    assert.match(first.stdout, /"inserted":4/);
    const db = new DatabaseSync(dbPath);
    assert.deepEqual(db.prepare(
      "SELECT mode, aid, nickname, nickname_lower FROM pve_player_index ORDER BY aid"
    ).all().map((row) => ({ ...row })), [
      { mode: "pve", aid: 42, nickname: "Valid_Player", nickname_lower: "valid_player" },
      { mode: "pve", aid: 43, nickname: "Second", nickname_lower: "second" },
      { mode: "pve", aid: 46, nickname: "Third", nickname_lower: "third" },
      { mode: "pve", aid: 47, nickname: "Fourth", nickname_lower: "fourth" },
    ]);
    assert.equal(db.prepare(
      "SELECT value FROM pve_player_index_meta WHERE key = 'etag'"
    ).get().value, etag);
    assert.equal(db.prepare(
      "SELECT value FROM pve_player_index_meta WHERE key = 'last_modified'"
    ).get().value, lastModified);
    assert.equal(db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'player_index'"
    ).get(), undefined);
    const metadata = Object.fromEntries(db.prepare(
      "SELECT key, value FROM pve_player_index_meta"
    ).all().map(({ key, value }) => [key, value]));
    assert.deepEqual(
      Object.fromEntries(["row_count", "source_rows", "skipped", "last_status"]
        .map((key) => [key, metadata[key]])),
      { row_count: "4", source_rows: "9", skipped: "5", last_status: "updated" },
    );
    assert.ok(Number(metadata.bytes) > 0);
    assert.ok(Number(metadata.duration_ms) >= 0);
    db.close();

    await launch(dbPath, url);
    assert.deepEqual(requests, [
      { etag: null, lastModified: null },
      { etag, lastModified },
    ]);

    payload = JSON.stringify({ "48": "Partial" });
    etag = '"pve-v2"';
    lastModified = "Sun, 23 Aug 2026 12:15:00 GMT";
    await assert.rejects(launch(dbPath, url, "--force"), /appears truncated/);
    const afterRejected = new DatabaseSync(dbPath);
    assert.equal(afterRejected.prepare("SELECT COUNT(*) AS n FROM pve_player_index").get().n, 4);
    afterRejected.close();

    payload = JSON.stringify({ "42": "Changed", "46": "New" });
    etag = '"pve-v3"';
    await launch(dbPath, url, "--force");
    const after = new DatabaseSync(dbPath);
    assert.deepEqual(after.prepare(
      "SELECT aid, nickname FROM pve_player_index ORDER BY aid"
    ).all().map((row) => ({ ...row })), [
      { aid: 42, nickname: "Changed" },
      { aid: 46, nickname: "New" },
    ]);
    after.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed PvE index leaves the last committed table untouched", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pve-index-rollback-"));
  const dbPath = join(directory, "players.db");
  let body = '{"42":"Stable"}';
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/pve/index.json`;

  try {
    await launch(dbPath, url);
    body = '{"42":"Replacement",';
    await assert.rejects(launch(dbPath, url, "--force"), /truncated or invalid index JSON/);
    const db = new DatabaseSync(dbPath);
    assert.deepEqual(db.prepare("SELECT aid, nickname FROM pve_player_index").all()
      .map((row) => ({ ...row })), [{ aid: 42, nickname: "Stable" }]);
    db.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("PvE index schema is separate and mode-aware", async () => {
  const migration = await readFile("scripts/pve-player-index-d1.sql", "utf8");
  const db = new DatabaseSync(":memory:");
  db.exec(migration);
  db.prepare(`INSERT INTO pve_player_index
    (mode, aid, nickname, nickname_lower, synced_at)
    VALUES (?, ?, ?, ?, ?)`)
    .run("pve", 7, "PveOnly", "pveonly", 1);
  assert.throws(() => db.prepare(`INSERT INTO pve_player_index
    (mode, aid, nickname, nickname_lower, synced_at)
    VALUES (?, ?, ?, ?, ?)`)
    .run("regular", 8, "NotPve", "notpve", 1));
  assert.equal(db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'player_index'"
  ).get(), undefined);
  db.close();
});
