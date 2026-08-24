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
    "--experimental-strip-types", "--experimental-sqlite",
    "scripts/sync-arena-index.mjs", "--db", dbPath, "--url", url, ...args,
  ], { cwd: process.cwd(), env: { ...process.env, NODE_NO_WARNINGS: "1" } });
}

test("Arena index downloads the full object and replaces its table atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-index-sync-"));
  const dbPath = join(directory, "players.db");
  let body = JSON.stringify({
    "41": "ArenaOne", "42": "Arena_Two", "43": "ArenaThree", "44": "ArenaFour", bad: "Ignored",
  });
  let etag = '"arena-v1"';
  const lastModified = "Mon, 24 Aug 2026 00:00:00 GMT";
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({
      etag: request.headers["if-none-match"] ?? null,
      lastModified: request.headers["if-modified-since"] ?? null,
    });
    if (request.headers["if-none-match"] === etag) return response.writeHead(304).end();
    response.setHeader("content-type", "application/json");
    response.setHeader("etag", etag);
    response.setHeader("last-modified", lastModified);
    for (const character of body) response.write(character);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/arena/index.json`;
  try {
    await launch(dbPath, url);
    const db = new DatabaseSync(dbPath);
    assert.deepEqual(db.prepare("SELECT mode, aid, nickname FROM arena_player_index ORDER BY aid")
      .all().map((row) => ({ ...row })), [
      { mode: "arena", aid: 41, nickname: "ArenaOne" },
      { mode: "arena", aid: 42, nickname: "Arena_Two" },
      { mode: "arena", aid: 43, nickname: "ArenaThree" },
      { mode: "arena", aid: 44, nickname: "ArenaFour" },
    ]);
    const metadata = Object.fromEntries(db.prepare(
      "SELECT key, value FROM arena_player_index_meta"
    ).all().map(({ key, value }) => [key, value]));
    assert.deepEqual(
      Object.fromEntries(["row_count", "source_rows", "skipped", "last_status", "last_modified"]
        .map((key) => [key, metadata[key]])),
      { row_count: "4", source_rows: "5", skipped: "1", last_status: "updated", last_modified: lastModified },
    );
    assert.ok(Number(metadata.bytes) > 0);
    assert.ok(Number(metadata.duration_ms) >= 0);
    db.close();
    await launch(dbPath, url);
    assert.deepEqual(requests[1], { etag, lastModified });
    body = JSON.stringify({ "45": "Partial" });
    etag = '"arena-v2"';
    await assert.rejects(launch(dbPath, url, "--force"), /appears truncated/);
    const afterRejected = new DatabaseSync(dbPath);
    assert.equal(afterRejected.prepare("SELECT COUNT(*) AS n FROM arena_player_index").get().n, 4);
    afterRejected.close();

    body = JSON.stringify({ "43": "Replacement", "44": "New" });
    etag = '"arena-v3"';
    await launch(dbPath, url, "--force");
    const replaced = new DatabaseSync(dbPath);
    assert.deepEqual(replaced.prepare("SELECT aid, nickname FROM arena_player_index").all()
      .map((row) => ({ ...row })), [
        { aid: 43, nickname: "Replacement" },
        { aid: 44, nickname: "New" },
      ]);
    replaced.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("empty Arena downloads preserve the last committed index", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-index-rollback-"));
  const dbPath = join(directory, "players.db");
  let body = '{"44":"Stable"}';
  const server = createServer((_request, response) => response.end(body));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/arena/index.json`;
  try {
    await launch(dbPath, url);
    body = "{}";
    await assert.rejects(launch(dbPath, url, "--force"), /contains no valid players/);
    const db = new DatabaseSync(dbPath);
    assert.deepEqual(db.prepare("SELECT aid, nickname FROM arena_player_index").all()
      .map((row) => ({ ...row })), [{ aid: 44, nickname: "Stable" }]);
    db.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }

  const migration = await readFile("scripts/arena-player-index-d1.sql", "utf8");
  const memory = new DatabaseSync(":memory:");
  memory.exec(migration);
  assert.throws(() => memory.prepare(`INSERT INTO arena_player_index
    (mode, aid, nickname, nickname_lower, synced_at) VALUES (?, ?, ?, ?, ?)`)
    .run("pve", 1, "Wrong", "wrong", 1));
  memory.close();
});

test("Arena index is wired into the runtime and daily Moscow schedule", async () => {
  const [packageSource, dockerfile, service, timer] = await Promise.all([
    readFile("package.json", "utf8"),
    readFile("Dockerfile", "utf8"),
    readFile("ops/systemd/tarkovstats-arena-index-sync.service", "utf8"),
    readFile("ops/systemd/tarkovstats-arena-index-sync.timer", "utf8"),
  ]);
  assert.match(packageSource, /"sync:arena-index": "node --experimental-strip-types --experimental-sqlite scripts\/sync-arena-index\.mjs"/);
  assert.match(dockerfile, /scripts\/sync-arena-index\.mjs/);
  assert.match(service, /flock \/run\/tarkovstats-data-sync\.lock/);
  assert.match(timer, /OnCalendar=\*-\*-\* 00:30:00 Europe\/Moscow/);
});
