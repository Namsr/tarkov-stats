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
const cycleId = "index-test";

function launch(dbPath, url, ...args) {
  return execFileAsync(process.execPath, [
    "--experimental-strip-types", "--experimental-sqlite",
    "scripts/sync-seasonal-index.mjs", "--db", dbPath, "--url", url, ...args,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
      SEASONAL_CYCLE_ID: cycleId,
      SEASONAL_STARTS_AT: "2026-01-01T00:00:00Z",
      SEASONAL_UPSTREAM_CONTRACT: "direct_profile",
      SEASONAL_COLLECTION_SOURCE: "json_feed",
      SEASONAL_UPSTREAM_FIXTURE_CONFIRMED: "true",
      SEASONAL_PROFILE_URL_TEMPLATE: "https://players.tarkov.dev/pvp-season/profile/{aid}.json",
      SEASONAL_PROFILE_UPDATED_URL: "https://players.tarkov.dev/pvp-season/updated.json",
      SEASONAL_PROFILE_INDEX_URL: "https://players.tarkov.dev/pvp-season/index.json",
    },
  });
}

test("Seasonal index streams atomically, persists validators and preserves a non-truncated table", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seasonal-index-sync-"));
  const dbPath = join(directory, "progression.db");
  let body = JSON.stringify({ "11": "Alpha", "12": "Beta", "13": "Gamma", "14": "Delta" });
  let etag = '"seasonal-v1"';
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
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM seasonal_player_index WHERE cycle_id = ?")
      .get(cycleId).n, 4);
    const metadata = Object.fromEntries(db.prepare(
      "SELECT key, value FROM seasonal_player_index_meta WHERE cycle_id = ?",
    ).all(cycleId).map(({ key, value }) => [key, value]));
    assert.equal(metadata.row_count, "4");
    assert.equal(metadata.source_rows, "4");
    assert.equal(metadata.skipped, "0");
    assert.equal(metadata.etag, etag);
    assert.equal(metadata.last_modified, lastModified);
    assert.ok(Number(metadata.bytes) > 0);
    assert.ok(Number(metadata.duration_ms) >= 0);
    db.close();

    await launch(dbPath, url);
    assert.deepEqual(requests[1], { etag, lastModified });

    body = JSON.stringify({ "15": "Partial" });
    etag = '"seasonal-v2"';
    await assert.rejects(launch(dbPath, url, "--force"), /appears truncated/);
    const afterRejected = new DatabaseSync(dbPath);
    assert.equal(afterRejected.prepare("SELECT COUNT(*) AS n FROM seasonal_player_index WHERE cycle_id = ?")
      .get(cycleId).n, 4);
    afterRejected.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
