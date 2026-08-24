import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const execFileAsync = promisify(execFile);

function launch(dbPath, url, ...args) {
  return execFileAsync(process.execPath, [
    "--experimental-strip-types", "--experimental-sqlite",
    "scripts/sync-player-index.mjs", "--db", dbPath, "--url", url, ...args,
  ], { cwd: process.cwd(), env: { ...process.env, NODE_NO_WARNINGS: "1" } });
}

test("regular index streams, keeps validators and rejects a truncated replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "player-index-sync-"));
  const dbPath = join(directory, "players.db");
  let body = JSON.stringify({ "1": "Alpha", "2": "Beta", "3": "Gamma", "4": "Delta" });
  let etag = '"regular-v1"';
  const lastModified = "Mon, 24 Aug 2026 00:00:00 GMT";
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({
      etag: request.headers["if-none-match"] ?? null,
      lastModified: request.headers["if-modified-since"] ?? null,
    });
    if (request.headers["if-none-match"] === etag) return response.writeHead(304).end();
    response.setHeader("etag", etag);
    response.setHeader("last-modified", lastModified);
    for (const character of body) response.write(character);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/index.json`;

  try {
    await launch(dbPath, url);
    const db = new DatabaseSync(dbPath);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM player_index").get().n, 4);
    const metadata = Object.fromEntries(db.prepare(
      "SELECT key, value FROM player_index_meta",
    ).all().map(({ key, value }) => [key, value]));
    assert.deepEqual(
      Object.fromEntries(["row_count", "source_rows", "skipped", "last_status", "etag", "last_modified"]
        .map((key) => [key, metadata[key]])),
      {
        row_count: "4",
        source_rows: "4",
        skipped: "0",
        last_status: "updated",
        etag,
        last_modified: lastModified,
      },
    );
    assert.ok(Number(metadata.bytes) > 0);
    assert.ok(Number(metadata.duration_ms) >= 0);
    db.close();

    await launch(dbPath, url);
    assert.deepEqual(requests[1], { etag, lastModified });

    body = JSON.stringify({ "5": "Partial" });
    etag = '"regular-v2"';
    await assert.rejects(launch(dbPath, url, "--force"), /appears truncated/);
    const afterRejected = new DatabaseSync(dbPath);
    assert.equal(afterRejected.prepare("SELECT COUNT(*) AS n FROM player_index").get().n, 4);
    afterRejected.close();

    body = JSON.stringify({ "5": "Replacement", "6": "Next" });
    etag = '"regular-v3"';
    await launch(dbPath, url, "--force");
    const replaced = new DatabaseSync(dbPath);
    assert.deepEqual(replaced.prepare("SELECT aid, nickname FROM player_index ORDER BY aid").all()
      .map((row) => ({ ...row })), [
      { aid: 5, nickname: "Replacement" },
      { aid: 6, nickname: "Next" },
    ]);
    replaced.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
