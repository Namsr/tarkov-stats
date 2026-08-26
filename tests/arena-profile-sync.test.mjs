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
const secret = "test-secret-that-is-at-least-32-characters";

function launch(dbPath, baseUrl, feedUrl) {
  return execFileAsync(process.execPath, [
    "--experimental-strip-types", "--experimental-sqlite", "scripts/sync-arena-profiles.mjs",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
      SQLITE_PATH: dbPath,
      PROFILE_REFRESH_SECRET: secret,
      ARENA_PROFILE_UPDATED_URL: feedUrl,
      ARENA_PROFILE_SYNC_BASE_URL: baseUrl,
      ARENA_PROFILE_SYNC_RPS: "20",
      ARENA_PROFILE_SYNC_MAX_RETRIES: "0",
    },
  });
}

test("Arena profile sync queues index gaps and updated-feed accounts without a total cap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-profile-sync-"));
  const dbPath = join(directory, "players.db");
  const initial = 1_800_000_000_000;
  const players = new DatabaseSync(dbPath);
  players.exec(`
    CREATE TABLE mode_players (
      mode TEXT NOT NULL, aid INTEGER NOT NULL, profile_updated_at INTEGER DEFAULT 0,
      fetched_at INTEGER NOT NULL, stats_json TEXT NOT NULL, achievements TEXT,
      PRIMARY KEY (mode, aid)
    );
    CREATE TABLE excluded_players (aid INTEGER PRIMARY KEY);
    CREATE TABLE arena_player_index (
      mode TEXT NOT NULL, aid INTEGER NOT NULL, nickname TEXT NOT NULL,
      nickname_lower TEXT NOT NULL, synced_at INTEGER NOT NULL,
      PRIMARY KEY (mode, aid)
    );
  `);
  players.prepare(`
    INSERT INTO mode_players (mode, aid, profile_updated_at, fetched_at, stats_json, achievements)
    VALUES ('arena', 2, ?, ?, '{}', '')
  `).run(initial, Date.now());
  const insertIndex = players.prepare(`
    INSERT INTO arena_player_index (mode, aid, nickname, nickname_lower, synced_at)
    VALUES ('arena', ?, ?, ?, ?)
  `);
  for (const [aid, nickname] of [[1, "One"], [2, "Two"], [3, "Three"], [4, "Four"]]) {
    insertIndex.run(aid, nickname, nickname.toLowerCase(), Date.now());
  }

  let feed = { 2: initial + 100, 3: initial + 200, 5: initial + 300 };
  const calls = [];
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith("/arena/updated.json")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(feed));
      return;
    }
    if (request.url !== "/api/operator/profile-refresh/sync") {
      response.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    calls.push(body.aid);
    if (body.aid === 3) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ state: "not_found" }));
      return;
    }
    players.prepare(`
      INSERT INTO mode_players (mode, aid, profile_updated_at, fetched_at, stats_json, achievements)
      VALUES ('arena', ?, ?, ?, '{}', '')
      ON CONFLICT(mode, aid) DO UPDATE SET profile_updated_at = excluded.profile_updated_at,
        fetched_at = excluded.fetched_at
    `).run(body.aid, body.expectedUpdatedAt, Date.now());
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ state: "updated", profileUpdatedAt: body.expectedUpdatedAt }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const feedUrl = `${baseUrl}/arena/updated.json`;

  try {
    await launch(dbPath, baseUrl, feedUrl);
    assert.deepEqual(calls.sort((a, b) => a - b), [1, 2, 3, 4, 5]);
    assert.deepEqual(players.prepare(
      "SELECT aid, status FROM arena_profile_sync_queue ORDER BY aid"
    ).all().map((row) => ({ aid: Number(row.aid), status: row.status })), [
      { aid: 1, status: "completed" },
      { aid: 2, status: "completed" },
      { aid: 3, status: "not_found" },
      { aid: 4, status: "completed" },
      { aid: 5, status: "completed" },
    ]);

    const callsAfterFirstRun = calls.length;
    feed = { ...feed, 6: initial + 400 };
    await launch(dbPath, baseUrl, feedUrl);
    assert.deepEqual(calls.slice(callsAfterFirstRun), [6]);
    assert.equal(players.prepare(
      "SELECT status FROM arena_profile_sync_queue WHERE aid = 3"
    ).get().status, "not_found");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    players.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Arena collector uses the JSON helper, one-request default, and an isolated queue", async () => {
  const [source, packageSource, dockerfile, service, timer, syncRoute, operatorProfile] = await Promise.all([
    readFile("scripts/sync-arena-profiles.mjs", "utf8"),
    readFile("package.json", "utf8"),
    readFile("Dockerfile", "utf8"),
    readFile("ops/systemd/tarkovstats-arena-profile-sync.service", "utf8"),
    readFile("ops/systemd/tarkovstats-arena-profile-sync.timer", "utf8"),
    readFile("app/api/operator/profile-refresh/sync/route.ts", "utf8"),
    readFile("lib/operator-profile.ts", "utf8"),
  ]);
  assert.match(source, /fetchTarkovJson/);
  assert.match(source, /https:\/\/players\.tarkov\.dev\/arena\/updated\.json/);
  assert.match(source, /arena_profile_sync_(queue|meta|lease)/);
  assert.match(source, /requestsPerSecond: envNumber\("ARENA_PROFILE_SYNC_RPS", 1,/);
  assert.match(source, /arena_player_index/);
  assert.doesNotMatch(source, /DELETE FROM arena_player_index\b/);
  assert.match(source, /processQueue\(startedAt\)/);
  assert.match(source, /payload\?\.state === "not_found"/);
  assert.match(source, /verified_not_found_v1/);
  assert.match(packageSource, /"sync:arena-profiles": "node --experimental-strip-types --experimental-sqlite scripts\/sync-arena-profiles\.mjs"/);
  assert.match(dockerfile, /scripts\/sync-arena-profiles\.mjs/);
  assert.match(service, /flock -n \/run\/tarkovstats-data-sync\.lock/);
  assert.match(service, /scripts\/sync-arena-profiles\.mjs/);
  assert.match(timer, /Description=Hourly TarkovStats Arena profile sync/);
  assert.match(timer, /OnCalendar=\*-\*-\* \*:50:00 Europe\/Moscow/);
  assert.match(syncRoute, /isOperatorRequest/);
  assert.match(syncRoute, /resolved\.payload\.mode === "arena"/);
  assert.match(operatorProfile, /getPublicProfile\(aid, \{ force: true, mode, expectedUpdatedAt \}\)/);
});
