import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const execFileAsync = promisify(execFile);
const { initializeSeasonalSchema } = await import("../lib/seasonal/storage.ts");
const cutoff = Date.parse("2025-11-15T00:00:00+03:00");

function runCollector(dbPath, progressionDbPath, port, retries = 0, extraEnv = {}) {
  return execFileAsync(process.execPath, [
    "--experimental-strip-types",
    "--experimental-sqlite",
    "scripts/sync-pve-profiles.mjs",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
      SQLITE_PATH: dbPath,
      PROGRESSION_SQLITE_PATH: progressionDbPath,
      PROFILE_REFRESH_SECRET: "test-secret-that-is-at-least-32-characters",
      PVE_PROFILE_UPDATED_URL: `http://127.0.0.1:${port}/pve/updated.json`,
      PVE_PROFILE_SYNC_BASE_URL: `http://127.0.0.1:${port}`,
      PVE_PROFILE_SYNC_RPS: "20",
      PVE_PROFILE_SYNC_MAX_RETRIES: String(retries),
      ...extraEnv,
    },
  });
}

function createPlayersDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE mode_players (
      mode TEXT NOT NULL, aid INTEGER NOT NULL, profile_updated_at INTEGER NOT NULL DEFAULT 0,
      fetched_at INTEGER NOT NULL DEFAULT 0, stats_json TEXT NOT NULL DEFAULT '{}', achievements TEXT
    );
    CREATE TABLE excluded_players (aid INTEGER PRIMARY KEY);
  `);
  return db;
}

test("PvE feed imports post-cutoff updated-only AIDs and keeps terminal outcomes isolated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pve-profile-sync-"));
  const dbPath = join(directory, "players.db");
  const progressionDbPath = join(directory, "progression.db");
  const players = createPlayersDb(dbPath);
  const progression = new DatabaseSync(progressionDbPath);
  initializeSeasonalSchema(progression);
  const seedStats = JSON.stringify({ experience: 100, pmcRaids: 1, scavRaids: 0, pmcSurvived: 1, pmcDeaths: 0, pmcKills: 1, killedPmc: 0 });
  players.prepare(`INSERT INTO mode_players
    (mode, aid, profile_updated_at, fetched_at, stats_json, achievements) VALUES ('pve', ?, ?, ?, ?, '[]')`)
    .run(90, cutoff, cutoff + 1, seedStats);
  players.prepare("INSERT INTO excluded_players (aid) VALUES (?)").run(16);
  let feed = {
    10: cutoff,
    11: String((cutoff + 1_000) / 1_000),
    12: cutoff + 2_000,
    13: cutoff + 3_000,
    14: cutoff + 4_000,
    15: cutoff + 5_000,
    16: cutoff + 6_000,
    17: cutoff - 1,
    90: cutoff + 7_000,
  };
  const calls = new Map();
  let failOnce = true;
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith("/pve/updated.json")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(feed));
      return;
    }
    if (request.url !== "/api/operator/pve/profile-sync") {
      response.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const { aid, mode, expectedUpdatedAt } = JSON.parse(raw);
    assert.equal(mode, "pve");
    calls.set(aid, (calls.get(aid) ?? 0) + 1);
    if (aid === 12) return response.writeHead(404).end();
    if (aid === 14) return response.writeHead(409).end();
    if (aid === 13) {
      response.setHeader("content-type", "application/json");
      return response.end(JSON.stringify({ state: "skipped_before_cutoff", profileUpdatedAt: expectedUpdatedAt }));
    }
    if (aid === 15 && failOnce) {
      failOnce = false;
      return response.writeHead(503).end("retry");
    }
    players.prepare(`INSERT INTO mode_players
      (mode, aid, profile_updated_at, fetched_at, stats_json, achievements) VALUES ('pve', ?, ?, ?, ?, '[]')`)
      .run(aid, expectedUpdatedAt, expectedUpdatedAt + 1, seedStats);
    progression.prepare(`INSERT OR IGNORE INTO progression_snapshots
      (mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at, local_date, stats_json)
      VALUES ('pve', 'persistent', ?, ?, ?, ?, 'x', ?)`)
      .run(aid, expectedUpdatedAt, expectedUpdatedAt, expectedUpdatedAt + 1, seedStats);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ state: "updated", profileUpdatedAt: expectedUpdatedAt }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    await runCollector(dbPath, progressionDbPath, port, 1);
    assert.equal(players.prepare("SELECT value FROM pve_profile_sync_meta WHERE key = 'feed_watermark'").get().value, String(cutoff + 7_000));
    assert.equal(progression.prepare("SELECT COUNT(*) AS n FROM progression_snapshots WHERE mode = 'pve'").get().n, 5);
    assert.deepEqual(players.prepare("SELECT aid, status, error FROM pve_profile_sync_queue ORDER BY aid").all()
      .map((row) => ({ ...row })), [
        { aid: 10, status: "completed", error: null },
        { aid: 11, status: "completed", error: null },
        { aid: 12, status: "not_found", error: null },
        { aid: 13, status: "skipped", error: "skipped_before_cutoff" },
        { aid: 14, status: "stale", error: null },
        { aid: 15, status: "completed", error: null },
        { aid: 90, status: "completed", error: null },
      ]);
    assert.equal(calls.has(16), false);
    assert.equal(calls.has(17), false);
    assert.equal(calls.get(15), 2);

    const firstCalls = new Map(calls);
    feed = { 11: String((cutoff + 1_000) / 1_000) };
    const { stdout: noAttemptStdout } = await runCollector(dbPath, progressionDbPath, port);
    assert.deepEqual(calls, firstCalls, "same terminal versions and disappearing AIDs are never reprocessed or deleted");
    assert.equal(players.prepare("SELECT COUNT(*) AS n FROM mode_players WHERE mode = 'pve' AND aid = 10").get().n, 1);
    const noAttemptSummaryLine = noAttemptStdout.split(/\r?\n/).find((line) => line.includes(" SUMMARY "));
    assert.ok(noAttemptSummaryLine, "collector writes a no-attempt summary");
    const noAttemptSummary = JSON.parse(
      noAttemptSummaryLine.slice(noAttemptSummaryLine.indexOf(" SUMMARY ") + " SUMMARY ".length),
    );
    assert.equal(noAttemptSummary.attempted, 0);
    assert.equal(noAttemptSummary.coverageTotal, 4);
    assert.equal(noAttemptSummary.snapshotCurrent, 4);

    feed = { 18: cutoff + 8_000 };
    const locker = new DatabaseSync(dbPath);
    locker.exec("BEGIN IMMEDIATE");
    let released = false;
    const release = setTimeout(() => {
      locker.exec("COMMIT");
      released = true;
    }, 500);
    try {
      const { stdout } = await runCollector(dbPath, progressionDbPath, port, 0, {
        PVE_PROFILE_SYNC_DB_BUSY_TIMEOUT_MS: "50",
        PVE_PROFILE_SYNC_DB_BUSY_RETRIES: "1",
      });
      assert.match(stdout, /DB_BUSY_RETRY/);
    } finally {
      clearTimeout(release);
      if (!released) locker.exec("ROLLBACK");
      locker.close();
    }
    assert.equal(calls.get(18), 1, "updated.json does not require a matching PvE index row");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    players.close();
    progression.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("PvE collector retries a terminated updated feed without retaining its partial state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pve-profile-sync-"));
  const dbPath = join(directory, "players.db");
  const progressionDbPath = join(directory, "progression.db");
  const players = createPlayersDb(dbPath);
  const progression = new DatabaseSync(progressionDbPath);
  initializeSeasonalSchema(progression);
  const stats = JSON.stringify({ experience: 100, pmcRaids: 1, scavRaids: 0, pmcSurvived: 1, pmcDeaths: 0, pmcKills: 1, killedPmc: 0 });
  const feed = JSON.stringify({ 20: cutoff });
  let feedRequests = 0;
  let syncRequests = 0;
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith("/pve/updated.json")) {
      feedRequests += 1;
      if (feedRequests === 1) {
        response.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(feed) + 1),
          connection: "close",
        });
        response.end(feed);
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(feed);
      return;
    }
    if (request.url !== "/api/operator/pve/profile-sync") return response.writeHead(404).end();
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const { aid, expectedUpdatedAt } = JSON.parse(raw);
    syncRequests += 1;
    players.prepare(`INSERT INTO mode_players
      (mode, aid, profile_updated_at, fetched_at, stats_json, achievements) VALUES ('pve', ?, ?, ?, ?, '[]')`)
      .run(aid, expectedUpdatedAt, expectedUpdatedAt + 1, stats);
    progression.prepare(`INSERT INTO progression_snapshots
      (mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at, local_date, stats_json)
      VALUES ('pve', 'persistent', ?, ?, ?, ?, 'x', ?)`).run(aid, expectedUpdatedAt, expectedUpdatedAt, expectedUpdatedAt + 1, stats);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ profileUpdatedAt: expectedUpdatedAt }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const { stdout } = await runCollector(dbPath, progressionDbPath, port, 1);
    const summaryLine = stdout.split(/\r?\n/).find((line) => line.includes(" SUMMARY "));
    assert.ok(summaryLine, "collector writes a summary");
    const summary = JSON.parse(summaryLine.slice(summaryLine.indexOf(" SUMMARY ") + " SUMMARY ".length));
    assert.equal(feedRequests, 2);
    assert.equal(summary.sourceEntries, 1);
    assert.equal(summary.queuedVersions, 1);
    assert.equal(syncRequests, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    players.close();
    progression.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("PvE collector uses the JSON helper and a distinct mode queue", async () => {
  const fs = await import("node:fs/promises");
  const [source, route] = await Promise.all([
    fs.readFile("scripts/sync-pve-profiles.mjs", "utf8"),
    fs.readFile("app/api/operator/pve/profile-sync/route.ts", "utf8"),
  ]);
  assert.match(source, /fetchTarkovJson/);
  assert.match(source, /https:\/\/players\.tarkov\.dev\/pve\/updated\.json/);
  assert.match(source, /pve_profile_sync_(queue|meta|lease)/);
  assert.match(source, /feedUpdatedAt < PVE_FEED_CUTOFF_MS/);
  assert.match(source, /seedPveProgressionBaselines/);
  assert.match(source, /\/api\/operator\/pve\/profile-sync/);
  assert.match(source, /maxRunMs: envInteger\("PVE_PROFILE_SYNC_MAX_RUN_MS", 12 \* 60_000, 60_000, 13 \* 60_000\)/);
  assert.match(source, /processQueue\(startedAt\)/);
  assert.match(source, /Date\.now\(\) - startedAt >= config\.maxRunMs/);
  assert.match(source, /PVE_PROFILE_SYNC_DB_BUSY_TIMEOUT_MS/);
  assert.match(source, /withDatabaseBusyRetry/);
  assert.doesNotMatch(source, /pve_player_index/);
  assert.match(route, /isOperatorRequest/);
  assert.match(route, /getPublicProfile\(input\.aid, \{[\s\S]*?mode: "pve"[\s\S]*?expectedUpdatedAt: input\.expectedUpdatedAt/);
  assert.match(route, /pveProfileDecision\(profile\)/);
  assert.match(route, /persistRegularProfileSnapshot\(snapshot, \{ mode: "pve", strict: true \}\)/);
  assert.match(route, /PublicProfileVersionConflictError[\s\S]*?status: 409/s);
  assert.doesNotMatch(route, /\bfetch\s*\(/);
});

test("PvE coverage counts a queued version ahead of the snapshot as lagging", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pve-profile-sync-coverage-"));
  const dbPath = join(directory, "players.db");
  const progressionDbPath = join(directory, "progression.db");
  const players = createPlayersDb(dbPath);
  const progression = new DatabaseSync(progressionDbPath);
  initializeSeasonalSchema(progression);
  const stats = JSON.stringify({ experience: 100, pmcRaids: 1, scavRaids: 0, pmcSurvived: 1, pmcDeaths: 0, pmcKills: 1, killedPmc: 0 });
  // aid 10: the snapshot equals the stored profile, but the queue already knows
  // upstream moved 5000 ms on and the fetch never happens.
  // aid 11: caught up, and must stay counted as current.
  for (const [aid, version] of [[10, cutoff + 1_000], [11, cutoff + 6_000]]) {
    players.prepare(`INSERT INTO mode_players (mode, aid, profile_updated_at, fetched_at, stats_json, achievements)
      VALUES ('pve', ?, ?, ?, ?, '[]')`).run(aid, version, version, stats);
    progression.prepare(`INSERT INTO progression_snapshots
      (mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at, local_date, stats_json)
      VALUES ('pve', 'persistent', ?, ?, ?, ?, 'x', ?)`)
      .run(aid, version, version, version + 1, stats);
  }
  players.exec(`CREATE TABLE pve_profile_sync_queue (
    aid INTEGER PRIMARY KEY, feed_updated_at INTEGER NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    http_status INTEGER, error TEXT, last_run_id TEXT, updated_at INTEGER NOT NULL);
    CREATE TABLE pve_profile_sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const queue = players.prepare("INSERT INTO pve_profile_sync_queue (aid, feed_updated_at, status, updated_at) VALUES (?, ?, ?, ?)");
  queue.run(10, cutoff + 6_000, "pending", 1);
  players.prepare("INSERT INTO pve_profile_sync_meta (key, value) VALUES ('feed_watermark', ?)").run(String(cutoff + 7_000));

  const feed = { 10: cutoff + 6_000, 11: cutoff + 6_000 };
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith("/pve/updated.json")) {
      response.setHeader("content-type", "application/json");
      return response.end(JSON.stringify(feed));
    }
    if (request.url !== "/api/operator/pve/profile-sync") return response.writeHead(404).end();
    for await (const chunk of request) void chunk;
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const summaryFrom = (stdout) => {
    const line = stdout.split(/\r?\n/).find((entry) => entry.includes(" SUMMARY "));
    assert.ok(line, "collector writes a summary");
    return JSON.parse(line.slice(line.indexOf(" SUMMARY ") + " SUMMARY ".length));
  };

  try {
    // No-attempt run: the budget expires before the queued aid is fetched, so
    // the pre-processing coverage loop reports the numbers.
    const noAttempt = summaryFrom((await runCollector(dbPath, progressionDbPath, port, 0, {
      PROFILE_QUEUE_DEADLINE_MS: "1",
    })).stdout);
    assert.equal(noAttempt.attempted, 0);
    assert.equal(noAttempt.snapshotLagging, 1, "a queued version ahead of the snapshot is lagging");
    assert.equal(noAttempt.snapshotCurrent, 1, "a caught-up profile is still current");
    assert.equal(noAttempt.snapshotMissing, 0);
    assert.equal(noAttempt.coverageTotal, 2);
    assert.equal(noAttempt.coveragePercent, 50);

    // Attempted run: the SQL fallback has to reach the same verdict. aid 12 has
    // no snapshot at all and is queued oldest, so it is fetched first (404 ->
    // not_found) and the advanced clock ends the run before aid 10 is reached.
    players.prepare(`INSERT INTO mode_players (mode, aid, profile_updated_at, fetched_at, stats_json, achievements)
      VALUES ('pve', 12, ?, ?, ?, '[]')`).run(cutoff + 7_000, cutoff + 7_000, stats);
    queue.run(12, cutoff + 7_000, "pending", 0);
    const preload = join(directory, "advance-clock.mjs");
    await writeFile(preload, `const originalFetch = globalThis.fetch;
      const realNow = Date.now; let offset = 0; Date.now = () => realNow() + offset;
      globalThis.fetch = async (...args) => {
        const response = await originalFetch(...args);
        if (args[1]?.method === "POST") offset += 60001;
        return response;
      };`);
    const attempted = summaryFrom((await runCollector(dbPath, progressionDbPath, port, 0, {
      PVE_PROFILE_SYNC_MAX_RUN_MS: "60000",
      PROFILE_QUEUE_DEADLINE_MS: String(Date.now() + 30_000),
      NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
    })).stdout);
    assert.equal(attempted.attempted, 1);
    assert.equal(
      players.prepare("SELECT status FROM pve_profile_sync_queue WHERE aid = 10").get().status,
      "pending",
      "the lagging profile is never fetched",
    );
    assert.equal(attempted.snapshotLagging, 1, "the SQL fallback applies the same queue-aware target");
    assert.equal(attempted.snapshotCurrent, 1, "the SQL fallback still counts the caught-up profile as current");
    assert.equal(attempted.snapshotMissing, 1, "the SQL fallback still counts the snapshotless profile as missing");
    assert.equal(attempted.coverageTotal, 3);
    assert.equal(attempted.coveragePercent, 33.3333);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    players.close();
    progression.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("PvE conditional feed requests skip the body on 304 but keep serving the queue", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pve-profile-sync-304-"));
  const dbPath = join(directory, "players.db");
  const progressionDbPath = join(directory, "progression.db");
  const players = createPlayersDb(dbPath);
  const progression = new DatabaseSync(progressionDbPath);
  initializeSeasonalSchema(progression);
  const stats = JSON.stringify({ experience: 100, pmcRaids: 1, scavRaids: 0, pmcSurvived: 1, pmcDeaths: 0, pmcKills: 1, killedPmc: 0 });
  const feed = { 10: cutoff + 1_000 };
  const ETAG = '"test-pve-etag-1"';
  const seen = { hits: 0, conditional: 0, bodies: 0 };
  const syncCalls = [];
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith("/pve/updated.json")) {
      seen.hits += 1;
      if (request.headers["if-none-match"] === ETAG) {
        seen.conditional += 1;
        response.writeHead(304).end();
        return;
      }
      seen.bodies += 1;
      response.setHeader("content-type", "application/json");
      response.setHeader("etag", ETAG);
      response.end(JSON.stringify(feed));
      return;
    }
    if (request.url !== "/api/operator/pve/profile-sync") return response.writeHead(404).end();
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const { aid, expectedUpdatedAt } = JSON.parse(raw);
    syncCalls.push(aid);
    players.prepare(`INSERT INTO mode_players
      (mode, aid, profile_updated_at, fetched_at, stats_json, achievements) VALUES ('pve', ?, ?, ?, ?, '[]')`)
      .run(aid, expectedUpdatedAt, expectedUpdatedAt + 1, stats);
    progression.prepare(`INSERT OR IGNORE INTO progression_snapshots
      (mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at, local_date, stats_json)
      VALUES ('pve', 'persistent', ?, ?, ?, ?, 'x', ?)`).run(aid, expectedUpdatedAt, expectedUpdatedAt, expectedUpdatedAt + 1, stats);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ state: "updated", profileUpdatedAt: expectedUpdatedAt }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const summaryFrom = (stdout) => {
    const line = stdout.split(/\r?\n/).find((entry) => entry.includes(" SUMMARY "));
    assert.ok(line, "collector writes a summary");
    return JSON.parse(line.slice(line.indexOf(" SUMMARY ") + " SUMMARY ".length));
  };

  try {
    const first = summaryFrom((await runCollector(dbPath, progressionDbPath, port)).stdout);
    assert.equal(first.feedHttpStatus, 200);
    assert.equal(first.feedNotModified, false);
    assert.equal(first.completed, 1);
    assert.equal(
      players.prepare("SELECT value FROM pve_profile_sync_meta WHERE key = 'feed_etag'").get().value,
      ETAG,
    );
    const watermark = players.prepare(
      "SELECT value FROM pve_profile_sync_meta WHERE key = 'feed_watermark'"
    ).get().value;
    const completedAt = players.prepare(
      "SELECT updated_at FROM pve_profile_sync_queue WHERE aid = 10"
    ).get().updated_at;

    // Unchanged feed: revalidate, skip the body, keep the accepted watermark.
    const second = summaryFrom((await runCollector(dbPath, progressionDbPath, port)).stdout);
    assert.equal(seen.conditional, 1);
    assert.equal(seen.bodies, 1);
    assert.equal(second.feedNotModified, true);
    assert.equal(second.feedHttpStatus, 304);
    assert.equal(second.attempted, 0);
    assert.equal(second.maxFeedUpdatedAt, cutoff + 1_000);
    assert.equal(
      players.prepare("SELECT updated_at FROM pve_profile_sync_queue WHERE aid = 10").get().updated_at,
      completedAt,
      "no-change runs must not rewrite already-satisfied queue rows",
    );
    assert.equal(
      players.prepare("SELECT value FROM pve_profile_sync_meta WHERE key = 'feed_watermark'").get().value,
      watermark,
    );

    // Both an already-completed local gap and an independent pending row
    // must be repaired without downloading an unchanged feed again.
    progression.prepare("DELETE FROM progression_snapshots WHERE mode = 'pve' AND aid = 10").run();
    for (const [aid, status] of [[20, "skipped"], [21, "stale"], [22, "not_found"]]) {
      players.prepare(`INSERT INTO mode_players VALUES ('pve', ?, ?, ?, ?, '[]')`)
        .run(aid, cutoff + 1_000, cutoff + 1_001, stats);
      players.prepare(`INSERT INTO pve_profile_sync_queue
        (aid, feed_updated_at, status, updated_at) VALUES (?, ?, ?, 1)`)
        .run(aid, cutoff + 1_000, status);
    }
    players.prepare(`INSERT INTO mode_players VALUES ('pve', 23, ?, ?, ?, '[]')`)
      .run(cutoff - 1, cutoff, stats);
    players.prepare(`INSERT INTO pve_profile_sync_queue
      (aid, feed_updated_at, status, attempts, http_status, error, last_run_id, updated_at)
      VALUES (?, ?, 'pending', 0, NULL, NULL, NULL, ?)`)
      .run(99, cutoff + 2_000, Date.now());
    syncCalls.length = 0;
    const third = summaryFrom((await runCollector(dbPath, progressionDbPath, port)).stdout);
    assert.equal(third.feedNotModified, true);
    assert.deepEqual(syncCalls, [99, 10], "older pending work precedes a newly reopened lower AID");
    assert.equal(third.attempted, 2);
    assert.equal(third.completed, 2);
    assert.equal(seen.bodies, 1);
    assert.deepEqual(players.prepare("SELECT status FROM pve_profile_sync_queue WHERE aid BETWEEN 20 AND 22 ORDER BY aid")
      .all().map((row) => row.status), ["skipped", "stale", "not_found"]);
    assert.equal(players.prepare("SELECT aid FROM pve_profile_sync_queue WHERE aid = 23").get(), undefined);
    assert.equal(
      players.prepare("SELECT status FROM pve_profile_sync_queue WHERE aid = 99").get().status,
      "completed",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    players.close();
    progression.close();
    await rm(directory, { recursive: true, force: true });
  }
});
