import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import {
  classifyFeedEntry,
  createTimestampObjectParser,
  feedCacheSlot,
  normalizeUpdatedAt,
  snapshotTargetVersion,
  summarizeCoverage,
} from "../scripts/regular-profile-sync-core.mjs";

const execFileAsync = promisify(execFile);

test("updated feed parser streams aid-to-version objects across arbitrary chunks", () => {
  const json = '{"13134885":1720000000000,"42":"1720000001"}';
  const entries = [];
  const parser = createTimestampObjectParser((aid, version) => entries.push([aid, version]));
  for (const character of json) parser.append(character);
  parser.finish();
  assert.deepEqual(entries, [
    ["13134885", 1720000000000],
    ["42", "1720000001"],
  ]);
  assert.equal(normalizeUpdatedAt(entries[1][1]), 1720000001000);
  assert.equal(normalizeUpdatedAt(0), null);
});

test("regular sync 404 path records not_found without ban or player deletion", async () => {
  const source = await readFile(new URL("../scripts/sync-regular-profiles.mjs", import.meta.url), "utf8");
  assert.match(source, /response\.status === 404/);
  assert.match(source, /kind: "not_found"/);
  assert.doesNotMatch(source, /confirmBanned|DELETE FROM players\b/);
});

test("bootstrap admits tracked updates but defers unknown accounts until the durable watermark exists", () => {
  const version = 1_720_000_000_000;
  assert.equal(classifyFeedEntry(0, version, null, 3_600_000), "updated");
  assert.equal(classifyFeedEntry(version, version, null, 3_600_000), null);
  assert.equal(classifyFeedEntry(undefined, version, null, 3_600_000), null);
});

test("watermark overlap admits late new accounts without reopening old feed history", () => {
  const watermark = 1_720_000_000_000;
  assert.equal(classifyFeedEntry(undefined, watermark + 1, watermark, 3_600_000), "new");
  assert.equal(classifyFeedEntry(undefined, watermark - 3_600_000, watermark, 3_600_000), "new");
  assert.equal(classifyFeedEntry(undefined, watermark - 3_600_001, watermark, 3_600_000), null);
});

test("updated feed cache key changes once per fifteen-minute slot", () => {
  assert.equal(feedCacheSlot(0), 0);
  assert.equal(feedCacheSlot(899_999), 0);
  assert.equal(feedCacheSlot(900_000), 1);
});

test("snapshot targets include player state and bootstrap missing legacy profiles", () => {
  assert.equal(snapshotTargetVersion(200, 100, null), 200);
  assert.equal(snapshotTargetVersion(100, 200, 50), 200);
  assert.equal(snapshotTargetVersion(0, 0, null), 1);
  assert.equal(snapshotTargetVersion(0, 0, 100), 0);
});

test("persistent queue can process unknown AIDs and retains 404 rows", async () => {
  const source = await readFile(new URL("../scripts/sync-regular-profiles.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /JOIN players p ON p\.aid = q\.aid/);
  assert.doesNotMatch(source, /NOT EXISTS \(SELECT 1 FROM players p WHERE p\.aid = regular_profile_sync_queue\.aid\)/);
  assert.match(source, /progression_sync\.progression_snapshots/);
  assert.match(source, /status IN \('pending', 'error'\)/);
});

test("collector fails clearly when progression schema is missing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "regular-profile-sync-schema-"));
  const dbPath = join(directory, "players.db");
  const progressionDbPath = join(directory, "progression.db");
  const db = new DatabaseSync(dbPath);
  const progressionDb = new DatabaseSync(progressionDbPath);
  db.exec("CREATE TABLE players (aid INTEGER PRIMARY KEY, profile_updated_at INTEGER DEFAULT 0)");
  db.close();
  progressionDb.close();
  try {
    await assert.rejects(execFileAsync(process.execPath, [
      "--experimental-sqlite",
      "scripts/sync-regular-profiles.mjs",
    ], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        NODE_NO_WARNINGS: "1",
        SQLITE_PATH: dbPath,
        PROGRESSION_SQLITE_PATH: progressionDbPath,
        PROFILE_REFRESH_SECRET: "test-secret-that-is-at-least-32-characters",
      },
    }), (error) => {
      assert.match(error.stdout, /progression_snapshots is missing/);
      return true;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("collector bootstraps, admits new AIDs, deduplicates, retries, and resumes errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "regular-profile-sync-"));
  const dbPath = join(directory, "players.db");
  const progressionDbPath = join(directory, "progression.db");
  const initial = 1_720_000_000_000;
  let feed = { 1: initial, 2: initial - 10_000 };
  const calls = new Map();
  const failOnce = new Set();
  const failAlways = new Set();
  const apiDb = new DatabaseSync(dbPath);
  const progressionDb = new DatabaseSync(progressionDbPath);
  apiDb.exec(`
    CREATE TABLE players (aid INTEGER PRIMARY KEY, profile_updated_at INTEGER DEFAULT 0);
    CREATE TABLE excluded_players (aid INTEGER PRIMARY KEY);
    INSERT INTO players (aid, profile_updated_at) VALUES (1, 0);
  `);
  progressionDb.exec(`
    CREATE TABLE progression_snapshots (
      id INTEGER PRIMARY KEY,
      mode TEXT NOT NULL,
      cycle_id TEXT NOT NULL,
      aid INTEGER NOT NULL,
      profile_updated_at INTEGER NOT NULL,
      UNIQUE(mode, cycle_id, aid, profile_updated_at)
    );
  `);

  const server = createServer(async (request, response) => {
    if (request.url?.startsWith("/profile/updated.json")) {
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
    const { aid, expectedUpdatedAt } = JSON.parse(raw);
    calls.set(aid, (calls.get(aid) ?? 0) + 1);
    if (aid === 3) {
      response.writeHead(404).end();
      return;
    }
    if (failAlways.has(aid) || failOnce.delete(aid)) {
      response.writeHead(503).end("try later");
      return;
    }
    apiDb.prepare(`
      INSERT INTO players (aid, profile_updated_at) VALUES (?, ?)
      ON CONFLICT(aid) DO UPDATE SET profile_updated_at = excluded.profile_updated_at
    `).run(aid, expectedUpdatedAt);
    progressionDb.prepare(`
      INSERT OR IGNORE INTO progression_snapshots (mode, cycle_id, aid, profile_updated_at)
      VALUES ('regular', 'persistent', ?, ?)
    `).run(aid, expectedUpdatedAt);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ profileUpdatedAt: expectedUpdatedAt }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const run = (maxRetries = 0) => execFileAsync(process.execPath, [
    "--experimental-sqlite",
    "scripts/sync-regular-profiles.mjs",
  ], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
      SQLITE_PATH: dbPath,
      PROGRESSION_SQLITE_PATH: progressionDbPath,
      PROFILE_REFRESH_SECRET: "test-secret-that-is-at-least-32-characters",
      REGULAR_PROFILE_UPDATED_URL: `http://127.0.0.1:${port}/profile/updated.json`,
      REGULAR_PROFILE_SYNC_BASE_URL: `http://127.0.0.1:${port}`,
      REGULAR_PROFILE_SYNC_RPS: "20",
      REGULAR_PROFILE_SYNC_MAX_RETRIES: String(maxRetries),
    },
  });

  try {
    await run();
    assert.equal(apiDb.prepare(
      "SELECT value FROM regular_profile_sync_meta WHERE key = 'feed_watermark'"
    ).get().value, String(initial));
    assert.deepEqual(apiDb.prepare(
      "SELECT aid, status FROM regular_profile_sync_queue ORDER BY aid"
    ).all().map((row) => ({ ...row })), [{ aid: 1, status: "completed" }]);

    feed = { ...feed, 2: initial + 1_000 };
    await run();
    assert.equal(apiDb.prepare("SELECT profile_updated_at FROM players WHERE aid = 2").get().profile_updated_at, initial + 1_000);
    const callsAfterNewAid = calls.get(2);
    await run();
    assert.equal(calls.get(2), callsAfterNewAid);

    apiDb.prepare("UPDATE players SET profile_updated_at = ? WHERE aid = 1").run(initial + 500);
    await run();
    assert.equal(progressionDb.prepare(
      "SELECT MAX(profile_updated_at) AS version FROM progression_snapshots WHERE aid = 1"
    ).get().version, initial + 500);

    apiDb.prepare("INSERT INTO players (aid, profile_updated_at) VALUES (?, ?)").run(6, initial + 5_000);
    await run();
    assert.equal(calls.get(6), 1);
    assert.equal(progressionDb.prepare(
      "SELECT MAX(profile_updated_at) AS version FROM progression_snapshots WHERE aid = 6"
    ).get().version, initial + 5_000);

    apiDb.prepare("INSERT INTO players (aid, profile_updated_at) VALUES (?, ?)").run(7, 0);
    await run();
    assert.equal(calls.get(7), 1);
    assert.equal(progressionDb.prepare(
      "SELECT MAX(profile_updated_at) AS version FROM progression_snapshots WHERE aid = 7"
    ).get().version, 1);

    feed = { ...feed, 3: initial + 2_000 };
    await run();
    assert.equal(apiDb.prepare(
      "SELECT status FROM regular_profile_sync_queue WHERE aid = 3"
    ).get().status, "not_found");
    const callsAfter404 = calls.get(3);
    await run();
    assert.equal(calls.get(3), callsAfter404);

    failOnce.add(4);
    feed = { ...feed, 4: initial + 3_000 };
    await run(1);
    assert.equal(calls.get(4), 2);
    assert.equal(apiDb.prepare(
      "SELECT status FROM regular_profile_sync_queue WHERE aid = 4"
    ).get().status, "completed");

    failAlways.add(5);
    feed = { ...feed, 5: initial + 4_000 };
    await run();
    assert.equal(apiDb.prepare(
      "SELECT status FROM regular_profile_sync_queue WHERE aid = 5"
    ).get().status, "error");
    assert.equal(apiDb.prepare(
      "SELECT value FROM regular_profile_sync_meta WHERE key = 'last_errors'"
    ).get().value, "1");
    failAlways.delete(5);
    await run();
    assert.equal(apiDb.prepare(
      "SELECT status FROM regular_profile_sync_queue WHERE aid = 5"
    ).get().status, "completed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    apiDb.close();
    progressionDb.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("VPS timers use Moscow midnight and quarter-hour feed slots with a waiting index lock", async () => {
  const regularTimer = await readFile(new URL("../ops/systemd/tarkovstats-regular-profile-sync.timer", import.meta.url), "utf8");
  const indexTimer = await readFile(new URL("../ops/systemd/tarkovstats-player-index-sync.timer", import.meta.url), "utf8");
  const indexService = await readFile(new URL("../ops/systemd/tarkovstats-player-index-sync.service", import.meta.url), "utf8");
  assert.match(regularTimer, /OnCalendar=\*-\*-\* \*:05,20,35,50:00 Europe\/Moscow/);
  assert.match(indexTimer, /OnCalendar=\*-\*-\* 00:00:00 Europe\/Moscow/);
  assert.doesNotMatch(regularTimer + indexTimer, /RandomizedDelaySec/);
  assert.match(indexService, /ExecStart=\/usr\/bin\/flock \/run\/tarkovstats-data-sync\.lock/);
  assert.doesNotMatch(indexService, /flock -n/);
});

test("coverage uses every tracked non-excluded regular profile", async () => {
  const source = await readFile(new URL("../scripts/sync-regular-profiles.mjs", import.meta.url), "utf8");
  assert.match(source, /WHERE e\.aid IS NULL/);
  assert.match(source, /snapshotMissing/);
  assert.match(source, /snapshotLagging/);
  assert.match(source, /snapshotCurrent/);
  assert.match(source, /missingFromFeed: Math\.max\(0, coverageSummary\.coverageTotal - trackedNonExcludedInFeed\)/);
  assert.doesNotMatch(source, /const coverageTotal = feed\.trackedInFeed/);
});

test("coverage summary keeps exact unresolved counts below one hundred percent", () => {
  assert.deepEqual(summarizeCoverage(50_986, 50_985), {
    coverageTotal: 50_986,
    covered: 50_985,
    unresolved: 1,
    coveragePercent: 99.998,
  });
  assert.equal(summarizeCoverage(2_000_000, 1_999_999).coveragePercent, 99.9999);
  assert.equal(summarizeCoverage(50_986, 50_986).coveragePercent, 100);
});
