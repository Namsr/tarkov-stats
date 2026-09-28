import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  classifySeasonalVersion,
  createStringObjectParser,
  createTimestampObjectParser,
  enqueueMissingSeasonalIndexProfiles,
  normalizeAid,
  normalizeNickname,
  seasonalIndexCacheUrl,
} from "../scripts/seasonal-profile-sync-core.mjs";
import { DatabaseSync } from "node:sqlite";

const execFileAsync = promisify(execFile);

test("Seasonal updated parser streams versions and normalizes timestamps", () => {
  const entries = [];
  const parser = createTimestampObjectParser((aid, updatedAt) => entries.push([aid, updatedAt]));
  for (const chunk of ['{"7":1700000000', ',"8":"1700000001000"}']) parser.append(chunk);
  parser.finish();
  assert.deepEqual(entries, [["7", 1700000000], ["8", "1700000001000"]]);
  assert.equal(classifySeasonalVersion(1700000000000, 1700000000000), "current");
  assert.equal(classifySeasonalVersion(1700000000000, 1700000001000), "superseded");
  assert.equal(classifySeasonalVersion(1700000001000, 1700000000000), "stale");
});

test("Seasonal index parser accepts only nickname strings", () => {
  const entries = [];
  const parser = createStringObjectParser((aid, nickname) => entries.push([aid, nickname]));
  for (const chunk of ['{"7":"Alpha', '","8":"Bad Nick"}']) parser.append(chunk);
  parser.finish();
  assert.deepEqual(entries, [["7", "Alpha"], ["8", "Bad Nick"]]);
  assert.equal(normalizeAid("7"), 7);
  assert.equal(normalizeAid("0"), null);
  assert.equal(normalizeNickname("Alpha"), "Alpha");
  assert.equal(normalizeNickname("Bad Nick"), null);
  assert.equal(
    seasonalIndexCacheUrl("https://players.tarkov.dev/pvp-season/index.json", 15 * 60_000),
    "https://players.tarkov.dev/pvp-season/index.json?v=1",
  );
});

test("Seasonal index entries without snapshots are queued exactly once", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE seasonal_player_index (
      cycle_id TEXT NOT NULL, aid INTEGER NOT NULL, nickname TEXT NOT NULL,
      nickname_lower TEXT NOT NULL, synced_at INTEGER NOT NULL,
      PRIMARY KEY (cycle_id, aid)
    );
    CREATE TABLE seasonal_profile_sync_queue (
      cycle_id TEXT NOT NULL, aid INTEGER NOT NULL, feed_updated_at INTEGER NOT NULL,
      status TEXT NOT NULL, attempts INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (cycle_id, aid, feed_updated_at)
    );
    CREATE TABLE progression_snapshots (mode TEXT, cycle_id TEXT, aid INTEGER);
    CREATE TABLE excluded_players (aid INTEGER PRIMARY KEY);
    INSERT INTO seasonal_player_index VALUES
      ('s1', 1, 'One', 'one', 10), ('s1', 2, 'Two', 'two', 10), ('s1', 3, 'Three', 'three', 10);
    INSERT INTO progression_snapshots VALUES ('seasonal', 's1', 1);
    INSERT INTO excluded_players VALUES (3);
  `);
  assert.deepEqual(enqueueMissingSeasonalIndexProfiles(db, "s1", 100, 200), {
    indexEntries: 3,
    indexedMissingQueued: 1,
  });
  assert.deepEqual(enqueueMissingSeasonalIndexProfiles(db, "s1", 100, 300), {
    indexEntries: 3,
    indexedMissingQueued: 0,
  });
  const queued = db.prepare("SELECT aid, feed_updated_at, status FROM seasonal_profile_sync_queue")
    .all().map((row) => ({ ...row }));
  assert.deepEqual(queued, [
    { aid: 2, feed_updated_at: 100, status: "pending" },
  ]);
  db.close();
});

test("Seasonal collectors use the authenticated capture endpoint and JSON helper", async () => {
  const profileSource = await readFile("scripts/sync-seasonal-profiles.mjs", "utf8");
  const indexSource = await readFile("scripts/sync-seasonal-index.mjs", "utf8");
  assert.match(profileSource, /fetchTarkovJson/);
  assert.match(indexSource, /fetchTarkovJson/);
  assert.match(profileSource, /\/api\/operator\/seasonal\/profile-sync/);
  assert.match(profileSource, /feed_updated_at/);
  assert.match(profileSource, /enqueueMissingSeasonalIndexProfiles/);
  assert.match(profileSource, /superseded/);
  assert.match(profileSource, /ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, feed_updated_at, aid LIMIT 1/);
  assert.match(profileSource + indexSource, /isSeasonalCollectorReady/);
  assert.doesNotMatch(profileSource + indexSource, /isSeasonalRolloutReady/);
  assert.doesNotMatch(profileSource + indexSource, /api\.tarkov\.dev\/graphql|\bgraphql\b/i);
});

test("Seasonal collector cuts the retry ladder when the run budget is spent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seasonal-profile-sync-budget-"));
  const dbPath = join(directory, "progression.db");
  const attemptLog = join(directory, "attempts.log");
  const version = Date.now() - 3_600_000;
  // The Seasonal collector is fail-closed to https://players.tarkov.dev feeds,
  // so the stub answers the feed in-process. One failing attempt spends the whole
  // remaining budget, so the ladder must be cut instead of sleeping 1s+2s+4s
  // past `maxRunMs`; the faked clock keeps the regression free of real seconds.
  const preload = join(directory, "stub-fetch.mjs");
  await writeFile(preload, `import { appendFileSync } from "node:fs";
    const realNow = Date.now; let offset = 0; Date.now = () => realNow() + offset;
    globalThis.fetch = async (input, init) => {
      if (init?.method === "POST") {
        appendFileSync(process.env.SEASONAL_TEST_ATTEMPT_LOG, "attempt\\n");
        offset += 10_000;
        return new Response("try later", { status: 503 });
      }
      return new Response(JSON.stringify({ 7: ${version} }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };`);

  try {
    const { stdout } = await execFileAsync(process.execPath, [
      "--import", pathToFileURL(preload).href,
      "--experimental-strip-types",
      "--experimental-sqlite",
      "scripts/sync-seasonal-profiles.mjs",
    ], {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        NODE_NO_WARNINGS: "1",
        PROGRESSION_SQLITE_PATH: dbPath,
        PROFILE_REFRESH_SECRET: "test-secret-that-is-at-least-32-characters",
        SEASONAL_CYCLE_ID: "s1",
        SEASONAL_STARTS_AT: String(Date.now() - 86_400_000),
        SEASONAL_COLLECTION_SOURCE: "json_feed",
        SEASONAL_UPSTREAM_CONTRACT: "game_mode",
        SEASONAL_UPSTREAM_FIXTURE_CONFIRMED: "true",
        SEASONAL_PROFILE_URL_TEMPLATE: "https://players.tarkov.dev/pvp-season/1/{aid}.json",
        SEASONAL_PROFILE_UPDATED_URL: "https://players.tarkov.dev/pvp-season/updated.json",
        SEASONAL_PROFILE_INDEX_URL: "https://players.tarkov.dev/pvp-season/index.json",
        SEASONAL_PROFILE_SYNC_BASE_URL: "http://127.0.0.1:9",
        SEASONAL_FEED_RPS: "20",
        SEASONAL_FEED_MAX_RETRIES: "3",
        SEASONAL_FEED_MAX_RUN_MS: "60000",
        PROFILE_QUEUE_DEADLINE_MS: String(Date.now() + 10_000),
        SEASONAL_TEST_ATTEMPT_LOG: attemptLog,
      },
    });
    const attempts = (await readFile(attemptLog, "utf8")).split("\n").filter(Boolean);
    assert.equal(attempts.length, 1, "the ladder must stop instead of sleeping past the run budget");
    const line = stdout.split(/\r?\n/).find((entry) => entry.includes(" SUMMARY "));
    assert.ok(line, "collector writes a summary");
    const summary = JSON.parse(line.slice(line.indexOf(" SUMMARY ") + " SUMMARY ".length));
    assert.equal(summary.stopped, true, "a spent budget ends the run instead of finishing the ladder");
    assert.equal(summary.errors, 0);
    const db = new DatabaseSync(dbPath);
    try {
      assert.equal(
        db.prepare("SELECT status FROM seasonal_profile_sync_queue WHERE aid = 7").get().status,
        "pending",
        "the untouched profile stays queued for the next run",
      );
    } finally {
      db.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Seasonal feed revalidates with stored validators and keeps the queue on 304", async () => {
  const profileSource = await readFile("scripts/sync-seasonal-profiles.mjs", "utf8");
  assert.match(profileSource, /feed_etag/);
  assert.match(profileSource, /feed_last_modified/);
  assert.match(profileSource, /feed_source_url/);
  assert.match(profileSource, /if-none-match/);
  assert.match(profileSource, /if-modified-since/);
  assert.match(profileSource, /status === 304/);
  assert.match(profileSource, /notModified: true/);
  assert.match(profileSource, /feedNotModified/);
  assert.match(profileSource, /feedHttpStatus/);
  assert.match(profileSource, /deleteMeta\("feed_etag"\)/);
  assert.match(profileSource, /enqueueMissingSeasonalIndexProfiles/);
  // 304 is handled before response.ok (ok is false for 304) and before any
  // body read; validators are stored only after the accepted feed commits.
  const requestFeed = profileSource.slice(profileSource.indexOf("async function requestFeed"));
  assert.ok(
    requestFeed.indexOf("status === 304") < requestFeed.indexOf("response.ok"),
    "304 must be handled before the ok/body path",
  );
  assert.match(requestFeed, /fetchTarkovJson/);
  assert.doesNotMatch(requestFeed, /getReader/);
});

test("Seasonal capture invalidates the average cache only after an inserted profile", async () => {
  const source = await readFile("app/api/operator/seasonal/profile-sync/route.ts", "utf8");

  assert.match(source, /if \(result\.capture\.inserted === true\) \{\s*revalidateTag\(SEASONAL_AVERAGE_CACHE_TAG, "max"\);\s*await markAveragePublicationDirty\(seasonalPublicationScope\(cycle\.cycleId\)\);\s*\}/s);
  assert.doesNotMatch(source, /warmAverageCaches|after\(/);
  assert.equal((source.match(/revalidateTag\(/g) ?? []).length, 1);
  assert.ok(
    source.indexOf("if (!result.ok)") < source.indexOf("if (result.capture.inserted === true)"),
    "failed captures must not invalidate the cache",
  );
  assert.ok(
    source.indexOf("result.capture.inserted === true") < source.indexOf("return Response.json({", source.indexOf("result.capture.inserted === true")),
    "duplicate/no-op captures must return through the normal response path without invalidation",
  );
});

test("Docker runtime contains the Seasonal collectors and their source imports", async () => {
  const dockerfile = await readFile("Dockerfile", "utf8");
  const startup = await readFile("scripts/start-web.mjs", "utf8");
  for (const path of [
    "scripts/sync-seasonal-profiles.mjs",
    "scripts/sync-seasonal-index.mjs",
    "scripts/seasonal-profile-sync-core.mjs",
    "scripts/regular-profile-sync-core.mjs",
    "lib/tarkov-api.ts",
    "lib/seasonal/config.ts",
    "lib/seasonal/storage.ts",
  ]) assert.match(dockerfile, new RegExp(path.replaceAll("/", "\\/")), path);
  assert.doesNotMatch(startup, /sync-seasonal-feed-loop\.mjs|sync-player-indexes-loop\.mjs/);
});

test("Seasonal timer uses the hourly Moscow cadence and shared waiting lock", async () => {
  const feedTimer = await readFile("ops/systemd/tarkovstats-seasonal-profile-sync.timer", "utf8");
  const indexTimer = await readFile("ops/systemd/tarkovstats-seasonal-index-sync.timer", "utf8");
  const feedService = await readFile("ops/systemd/tarkovstats-seasonal-profile-sync.service", "utf8");
  const indexService = await readFile("ops/systemd/tarkovstats-seasonal-index-sync.service", "utf8");
  assert.match(feedTimer, /Description=Hourly TarkovStats Seasonal JSON profile sync/);
  assert.match(feedTimer, /OnCalendar=\*-\*-\* \*:15:00 Europe\/Moscow/);
  assert.match(indexTimer, /OnCalendar=\*-\*-\* 00:10:00 Europe\/Moscow/);
  assert.match(feedService, /flock \/run\/tarkovstats-data-sync\.lock/);
  assert.match(indexService, /flock \/run\/tarkovstats-data-sync\.lock/);
  assert.match(feedService, /flock -n \/run\/tarkovstats-seasonal-sync\.lock/);
  assert.match(indexService, /flock \/run\/tarkovstats-seasonal-sync\.lock/);
  assert.match(feedService, /ConditionPathExists=\/opt\/tarkovstats-auto\/docker-compose\.vps\.yml/);
  assert.match(feedService, /WorkingDirectory=\/opt\/tarkovstats-auto/);
  assert.match(indexService, /ConditionPathExists=\/opt\/tarkovstats-auto\/docker-compose\.vps\.yml/);
  assert.match(indexService, /WorkingDirectory=\/opt\/tarkovstats-auto/);
});

// The collector refuses to start unless the feed URLs are the real
// players.tarkov.dev ones, so the fixture server is reached by rewriting only
// the host inside a preload instead of weakening the readiness gate.
const FEED_HOST_PRELOAD = `
const origin = process.env.SEASONAL_TEST_FEED_ORIGIN;
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return Reflect.apply(nativeFetch, globalThis, [url.replace("https://players.tarkov.dev", origin), init]);
};
`;

test("Seasonal profile queue purges and skips moderation-excluded accounts", async () => {
  const { initializeSeasonalSchema } = await import("../lib/seasonal/storage.ts");
  const directory = await mkdtemp(join(tmpdir(), "seasonal-profile-excluded-"));
  const dbPath = join(directory, "progression.db");
  const preloadPath = join(directory, "feed-host-preload.cjs");
  await writeFile(preloadPath, FEED_HOST_PRELOAD);
  const cycleId = "excluded-test";
  const startsAt = Date.parse("2026-01-01T00:00:00Z");
  const feedUpdatedAt = startsAt + 1_000;

  // Both accounts are queued while they are still allowed, then aid 22 is
  // banned: confirmManualBan writes only the tombstone, so the queue row and
  // the snapshot survive it.
  const db = new DatabaseSync(dbPath);
  initializeSeasonalSchema(db);
  db.exec(`
    CREATE TABLE seasonal_profile_sync_queue (
      cycle_id TEXT NOT NULL,
      aid INTEGER NOT NULL,
      feed_updated_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'not_found', 'error', 'superseded')),
      attempts INTEGER NOT NULL DEFAULT 0,
      http_status INTEGER,
      error TEXT,
      last_run_id TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (cycle_id, aid, feed_updated_at)
    );
  `);
  const enqueue = db.prepare(`INSERT INTO seasonal_profile_sync_queue
    (cycle_id, aid, feed_updated_at, status, updated_at) VALUES (?, ?, ?, 'pending', ?)`);
  enqueue.run(cycleId, 21, feedUpdatedAt, 10);
  enqueue.run(cycleId, 22, feedUpdatedAt, 10);
  db.prepare("INSERT INTO excluded_players (aid, reason, created_at) VALUES (22, 'admin_manual', ?)")
    .run(20);
  db.close();

  const posted = [];
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith("/pvp-season/updated.json")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ 21: feedUpdatedAt }));
      return;
    }
    if (request.url !== "/api/operator/seasonal/profile-sync") {
      response.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const { aid, cycleId: bodyCycleId } = JSON.parse(raw);
    assert.equal(bodyCycleId, cycleId);
    posted.push(aid);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ profileUpdatedAt: feedUpdatedAt, capture: { inserted: true } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  try {
    await execFileAsync(process.execPath, [
      "--require", preloadPath,
      "--experimental-strip-types",
      "--experimental-sqlite",
      "scripts/sync-seasonal-profiles.mjs",
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_NO_WARNINGS: "1",
        SEASONAL_TEST_FEED_ORIGIN: origin,
        PROGRESSION_SQLITE_PATH: dbPath,
        PROFILE_REFRESH_SECRET: "test-secret-that-is-at-least-32-characters",
        SEASONAL_PROFILE_SYNC_BASE_URL: origin,
        SEASONAL_FEED_RPS: "20",
        SEASONAL_FEED_MAX_RETRIES: "0",
        SEASONAL_CYCLE_ID: cycleId,
        SEASONAL_STARTS_AT: new Date(startsAt).toISOString(),
        SEASONAL_UPSTREAM_CONTRACT: "direct_profile",
        SEASONAL_COLLECTION_SOURCE: "json_feed",
        SEASONAL_UPSTREAM_FIXTURE_CONFIRMED: "true",
        SEASONAL_PROFILE_URL_TEMPLATE: "https://players.tarkov.dev/pvp-season/profile/{aid}.json",
        SEASONAL_PROFILE_UPDATED_URL: "https://players.tarkov.dev/pvp-season/updated.json",
        SEASONAL_PROFILE_INDEX_URL: "https://players.tarkov.dev/pvp-season/index.json",
      },
    });

    const after = new DatabaseSync(dbPath);
    const queue = after.prepare(
      "SELECT aid, status FROM seasonal_profile_sync_queue WHERE cycle_id = ? ORDER BY aid",
    ).all(cycleId).map((row) => ({ ...row }));
    const summary = JSON.parse(after.prepare(
      "SELECT value FROM seasonal_profile_sync_meta WHERE cycle_id = ? AND key = 'last_summary'",
    ).get(cycleId).value);
    after.close();

    // The tombstoned account costs no upstream request and leaves no queue row;
    // an account without a tombstone is still captured.
    assert.deepEqual(posted, [21]);
    assert.deepEqual(queue, [{ aid: 21, status: "completed" }]);
    assert.equal(summary.attempted, 1);
    assert.equal(summary.completed, 1);
    assert.equal(summary.backlog, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

// A ban confirmed while the collector is already past its purge is honoured by
// the claim itself; the leftover row is drained by the next poll's purge.
test("Seasonal profile queue stops claiming an account banned mid-run", async () => {
  const { initializeSeasonalSchema } = await import("../lib/seasonal/storage.ts");
  const directory = await mkdtemp(join(tmpdir(), "seasonal-profile-midrun-ban-"));
  const dbPath = join(directory, "progression.db");
  const preloadPath = join(directory, "feed-host-preload.cjs");
  await writeFile(preloadPath, FEED_HOST_PRELOAD);
  const cycleId = "midrun-ban-test";
  const startsAt = Date.parse("2026-01-01T00:00:00Z");
  const feedUpdatedAt = startsAt + 1_000;

  const db = new DatabaseSync(dbPath);
  initializeSeasonalSchema(db);
  db.exec(`
    CREATE TABLE seasonal_profile_sync_queue (
      cycle_id TEXT NOT NULL,
      aid INTEGER NOT NULL,
      feed_updated_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'not_found', 'error', 'superseded')),
      attempts INTEGER NOT NULL DEFAULT 0,
      http_status INTEGER,
      error TEXT,
      last_run_id TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (cycle_id, aid, feed_updated_at)
    );
  `);
  const enqueue = db.prepare(`INSERT INTO seasonal_profile_sync_queue
    (cycle_id, aid, feed_updated_at, status, updated_at) VALUES (?, ?, ?, 'pending', ?)`);
  enqueue.run(cycleId, 31, feedUpdatedAt, 10);
  enqueue.run(cycleId, 32, feedUpdatedAt, 10);
  db.close();

  const posted = [];
  const moderator = new DatabaseSync(dbPath);
  moderator.exec("PRAGMA busy_timeout = 30000");
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith("/pvp-season/updated.json")) {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({}));
      return;
    }
    if (request.url !== "/api/operator/seasonal/profile-sync") {
      response.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const { aid } = JSON.parse(raw);
    posted.push(aid);
    // The purge already ran by the time the first capture is requested, so
    // only the claim-time exclusion can still stop aid 32.
    if (aid === 31) {
      moderator.prepare("INSERT INTO excluded_players (aid, reason, created_at) VALUES (32, 'admin_manual', ?)")
        .run(Date.now());
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ profileUpdatedAt: feedUpdatedAt, capture: { inserted: true } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  try {
    await execFileAsync(process.execPath, [
      "--require", preloadPath,
      "--experimental-strip-types",
      "--experimental-sqlite",
      "scripts/sync-seasonal-profiles.mjs",
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_NO_WARNINGS: "1",
        SEASONAL_TEST_FEED_ORIGIN: origin,
        PROGRESSION_SQLITE_PATH: dbPath,
        PROFILE_REFRESH_SECRET: "test-secret-that-is-at-least-32-characters",
        SEASONAL_PROFILE_SYNC_BASE_URL: origin,
        SEASONAL_FEED_RPS: "20",
        SEASONAL_FEED_MAX_RETRIES: "0",
        SEASONAL_CYCLE_ID: cycleId,
        SEASONAL_STARTS_AT: new Date(startsAt).toISOString(),
        SEASONAL_UPSTREAM_CONTRACT: "direct_profile",
        SEASONAL_COLLECTION_SOURCE: "json_feed",
        SEASONAL_UPSTREAM_FIXTURE_CONFIRMED: "true",
        SEASONAL_PROFILE_URL_TEMPLATE: "https://players.tarkov.dev/pvp-season/profile/{aid}.json",
        SEASONAL_PROFILE_UPDATED_URL: "https://players.tarkov.dev/pvp-season/updated.json",
        SEASONAL_PROFILE_INDEX_URL: "https://players.tarkov.dev/pvp-season/index.json",
      },
    });

    const after = new DatabaseSync(dbPath);
    const queue = after.prepare(
      "SELECT aid, status FROM seasonal_profile_sync_queue WHERE cycle_id = ? ORDER BY aid",
    ).all(cycleId).map((row) => ({ ...row }));
    after.close();

    assert.deepEqual(posted, [31]);
    assert.deepEqual(queue, [{ aid: 31, status: "completed" }, { aid: 32, status: "pending" }]);
  } finally {
    moderator.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
