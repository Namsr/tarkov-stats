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

// A missing clamp lets the feed ladder run out of retries and rethrow the 503 as
// FATAL, so the process exits non-zero before any assertion runs. Resolving with
// the exit code keeps the detection on the request count, which is the signal the
// regression actually moves.
async function runCollectorReportingExit(args, options) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, options);
    return { stdout, stderr, code: 0 };
  } catch (error) {
    return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code ?? 1 };
  }
}

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
    assert.equal(summary.stopReason, "max_run_ms", "a cut run names the reason, so it cannot read as a clean drain");
    assert.equal(summary.errors, 0, "a cut attempt is deferred, not failed; the row stays queued");
    assert.match(stdout, / RUN_CUT \{"stopReason":"max_run_ms","remainingMs":0,"phase":"\w+","aid":7,"attempt":1\}/);
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

test("Seasonal feed ladder stops at the run budget instead of sleeping past it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seasonal-profile-sync-feed-budget-"));
  const dbPath = join(directory, "progression.db");
  const feedLog = join(directory, "feed.log");
  const waitLog = join(directory, "wait.log");
  await writeFile(waitLog, "");

  const startedAt = Date.now();
  try {
    const { stdout, code } = await runCollectorReportingExit([
      "--import", new URL("fixtures/feed-budget-clock.mjs", import.meta.url).href,
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
        SEASONAL_FEED_MAX_RETRIES: "3",
        SEASONAL_FEED_MAX_RUN_MS: "60000",
        PROFILE_QUEUE_DEADLINE_MS: String(startedAt + 700),
        PROFILE_TEST_FEED_LOG: feedLog,
        PROFILE_TEST_WAIT_LOG: waitLog,
      },
    });
    const feedRequests = (await readFile(feedLog, "utf8").catch(() => "")).split("\n").filter(Boolean);
    assert.equal(feedRequests.length, 1, "the feed ladder must stop instead of sleeping past the run budget");
    assert.equal(code, 0, "a spent budget is a cut run, not a collector failure");
    assert.doesNotMatch(stdout, / FATAL /, "a spent budget is a cut run, not a collector failure");
    assert.equal(await readFile(waitLog, "utf8"), "",
      "the feed ladder must refuse retry waits that exceed its remaining budget");
    const cut = stdout.split(/\r?\n/).find((entry) => entry.includes(" RUN_CUT "));
    assert.ok(cut, "the cut is logged");
    const fields = JSON.parse(cut.slice(cut.indexOf(" RUN_CUT ") + " RUN_CUT ".length));
    assert.equal(fields.stopReason, "max_run_ms");
    assert.equal(fields.phase, "feed");
    assert.ok(fields.remainingMs < 1_000, "the log reports the budget the ladder gave up on");
    const db = new DatabaseSync(dbPath);
    try {
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM seasonal_profile_sync_queue").get().n,
        0,
        "a feed that was never admitted queues nothing",
      );
    } finally {
      db.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Seasonal rate-limit wait is clamped to the run budget", async () => {
  const directory = await mkdtemp(join(tmpdir(), "seasonal-profile-sync-rate-limit-"));
  const dbPath = join(directory, "progression.db");
  const attemptLog = join(directory, "attempts.log");
  const version = Date.now() - 3_600_000;
  // 0.1 RPS is the configured floor: the second profile's rate-limit wait is
  // 10s, which no longer fits in the ~1.2s left of the run budget. The wait has
  // to be clamped, otherwise the collector keeps sleeping a full spacing after
  // the deadline and the unfixed run ends ~10s past it.
  const preload = join(directory, "stub-fetch.mjs");
  await writeFile(preload, `import { appendFileSync } from "node:fs";
    globalThis.fetch = async (input, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(init.body);
        appendFileSync(process.env.SEASONAL_TEST_ATTEMPT_LOG, body.aid + "\\n");
        return Response.json({ profileUpdatedAt: body.expectedUpdatedAt, capture: { inserted: true } });
      }
      return Response.json({ 7: ${version}, 8: ${version} });
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
        SEASONAL_FEED_RPS: "0.1",
        SEASONAL_FEED_MAX_RUN_MS: "60000",
        PROFILE_QUEUE_DEADLINE_MS: String(Date.now() + 1_200),
        SEASONAL_TEST_ATTEMPT_LOG: attemptLog,
      },
    });
    const captured = (await readFile(attemptLog, "utf8")).split("\n").filter(Boolean);
    assert.deepEqual(captured, ["7"], "the second profile waits for a spacing that no longer fits");
    const line = stdout.split(/\r?\n/).find((entry) => entry.includes(" SUMMARY "));
    assert.ok(line, "collector writes a summary");
    const summary = JSON.parse(line.slice(line.indexOf(" SUMMARY ") + " SUMMARY ".length));
    assert.equal(summary.attempted, 2, "the cut profile was claimed before its wait was refused");
    assert.equal(summary.completed, 1);
    assert.equal(summary.stopped, true);
    assert.equal(summary.stopReason, "max_run_ms");
    assert.ok(
      summary.durationMs < 4_000,
      `the run must end on time, not one 10s spacing past the deadline (was ${summary.durationMs}ms)`,
    );
    const cutLine = stdout.split(/\r?\n/).find((entry) => entry.includes(" RUN_CUT "));
    assert.ok(cutLine, "collector logs the rate-limit budget cut");
    const cut = JSON.parse(cutLine.slice(cutLine.indexOf(" RUN_CUT ") + " RUN_CUT ".length));
    assert.equal(cut.stopReason, "max_run_ms");
    assert.equal(cut.phase, "rate_limit");
    assert.equal(cut.aid, 8);
    assert.equal(cut.attempt, 1);
    assert.ok(Number.isInteger(cut.remainingMs) && cut.remainingMs >= 0 && cut.remainingMs <= 50,
      `the timer may wake slightly before the deadline (remaining ${cut.remainingMs}ms)`);
    const db = new DatabaseSync(dbPath);
    try {
      assert.equal(
        db.prepare("SELECT status FROM seasonal_profile_sync_queue WHERE aid = 8").get().status,
        "pending",
        "the unclaimed profile stays queued for the next run",
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
  ]) assert.match(dockerfile, new RegExp(path.replaceAll("/", "\\/")), path);
  assert.match(dockerfile, /COPY --from=builder --chown=nextjs:nodejs \/app\/lib \.\/lib/);
  for (const path of ["lib/tarkov-api.ts", "lib/seasonal/config.ts", "lib/seasonal/storage.ts"]) {
    assert.ok((await readFile(path, "utf8")).length > 0, path);
  }
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
  assert.match(feedService, /flock -w 180 \/run\/tarkovstats-data-sync\.lock/);
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

test("delayed tracked Seasonal versions recover once, replay old validators and skip satisfied tasks", async () => {
  const { initializeSeasonalSchema } = await import("../lib/seasonal/storage.ts");
  const directory = await mkdtemp(join(tmpdir(), "seasonal-delayed-feed-"));
  const dbPath = join(directory, "progression.db");
  const preloadPath = join(directory, "feed-host-preload.cjs");
  await writeFile(preloadPath, FEED_HOST_PRELOAD);
  const now = Date.now();
  const day = 86_400_000;
  const startsAt = now - 30 * day;
  const delayed = now - 26 * 3_600_000;
  const latest = now - 60_000;
  const cycleId = "delayed-feed";
  const db = new DatabaseSync(dbPath);
  initializeSeasonalSchema(db);
  const snapshot = db.prepare(`INSERT INTO progression_snapshots
    (mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at, local_date)
    VALUES ('seasonal', ?, ?, ?, ?, ?, '2026-10-18')`);
  for (const [aid, version] of [[7, now - 8 * day], [8, delayed], [9, latest], [13, now - 8 * day], [16, latest]]) {
    snapshot.run(cycleId, aid, version, version, now);
  }
  snapshot.run("other-cycle", 14, now - 8 * day, now - 8 * day, now);
  db.prepare("INSERT INTO excluded_players (aid, reason, created_at) VALUES (13, 'admin_manual', ?)").run(now);
  db.exec(`
    CREATE TABLE seasonal_profile_sync_meta (cycle_id TEXT, key TEXT, value TEXT, PRIMARY KEY(cycle_id, key));
    CREATE TABLE seasonal_profile_sync_queue (
      cycle_id TEXT, aid INTEGER, feed_updated_at INTEGER, status TEXT,
      attempts INTEGER DEFAULT 0, http_status INTEGER, error TEXT, last_run_id TEXT, updated_at INTEGER,
      PRIMARY KEY(cycle_id, aid, feed_updated_at)
    );
  `);
  const meta = db.prepare("INSERT INTO seasonal_profile_sync_meta VALUES (?, ?, ?)");
  for (const [key, value] of [["feed_policy", "recent-24h-v1"], ["feed_etag", '"old"'],
    ["feed_source_url", "https://players.tarkov.dev/pvp-season/updated.json"]]) meta.run(cycleId, key, value);
  db.prepare("INSERT INTO seasonal_profile_sync_queue (cycle_id,aid,feed_updated_at,status,updated_at) VALUES (?,?,?,'pending',?)")
    .run(cycleId, 16, delayed, now);

  db.prepare("INSERT INTO seasonal_profile_sync_queue (cycle_id,aid,feed_updated_at,status,http_status,updated_at) VALUES (?,?,?,'superseded',409,?)")
    .run(cycleId, 17, delayed, now);
  const posted = [];
  const validators = [];
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith("/pvp-season/updated.json")) {
      validators.push(request.headers["if-none-match"] ?? null);
      if (validators.length >= 3) { response.writeHead(304).end(); return; }
      response.setHeader("etag", '"current"');
      response.end(JSON.stringify({ 7: delayed, 8: delayed, 9: delayed, 10: delayed,
        11: now + day, 12: startsAt - 1, 13: delayed, 14: delayed, 16: delayed }));
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    posted.push(body);
    snapshot.run(cycleId, body.aid, latest, latest, Date.now());
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ profileUpdatedAt: latest, capture: { inserted: true } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (let pass = 0; pass < 4; pass += 1) {
      if (pass === 3) db.prepare("UPDATE seasonal_profile_sync_queue SET updated_at=0 WHERE aid=17").run();
      await execFileAsync(process.execPath, ["--require", preloadPath, "--experimental-strip-types",
        "--experimental-sqlite", "scripts/sync-seasonal-profiles.mjs"], {
        cwd: process.cwd(),
        env: { ...process.env, NODE_NO_WARNINGS: "1", SEASONAL_TEST_FEED_ORIGIN: origin,
          PROGRESSION_SQLITE_PATH: dbPath, PROFILE_REFRESH_SECRET: "test-secret-that-is-at-least-32-characters",
          SEASONAL_PROFILE_SYNC_BASE_URL: origin, SEASONAL_FEED_RPS: "20", SEASONAL_FEED_MAX_RETRIES: "0",
          SEASONAL_CYCLE_ID: cycleId, SEASONAL_STARTS_AT: String(startsAt),
          SEASONAL_UPSTREAM_CONTRACT: "direct_profile", SEASONAL_COLLECTION_SOURCE: "json_feed",
          SEASONAL_UPSTREAM_FIXTURE_CONFIRMED: "true",
          SEASONAL_PROFILE_URL_TEMPLATE: "https://players.tarkov.dev/pvp-season/{aid}.json",
          SEASONAL_PROFILE_UPDATED_URL: "https://players.tarkov.dev/pvp-season/updated.json",
          SEASONAL_PROFILE_INDEX_URL: "https://players.tarkov.dev/pvp-season/index.json" },
      });
    }
    assert.deepEqual(validators, [null, '"current"', '"current"', '"current"'], "an upgrade must replay the previously filtered feed before reusing validators");
    assert.deepEqual(posted, [{ aid: 7, cycleId, expectedUpdatedAt: delayed }, { aid: 17, cycleId, expectedUpdatedAt: delayed }],
      "the same-day conflict stays quiet, then retries next day even on 304; satisfied snapshots are not downloaded");
    assert.deepEqual(db.prepare("SELECT aid,status,attempts FROM seasonal_profile_sync_queue ORDER BY aid").all()
      .map((row) => ({ ...row })), [
      { aid: 7, status: "superseded", attempts: 1 },
      { aid: 16, status: "superseded", attempts: 0 },
      { aid: 17, status: "superseded", attempts: 1 },
    ]);
    assert.equal(db.prepare("SELECT MAX(profile_updated_at) AS version FROM progression_snapshots WHERE cycle_id=? AND aid=7")
      .get(cycleId).version, latest, "a response newer than the delayed feed becomes the latest snapshot");
  } finally {
    db.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test("Seasonal profile queue purges and skips moderation-excluded accounts", async () => {
  const { initializeSeasonalSchema } = await import("../lib/seasonal/storage.ts");
  const directory = await mkdtemp(join(tmpdir(), "seasonal-profile-excluded-"));
  const dbPath = join(directory, "progression.db");
  const preloadPath = join(directory, "feed-host-preload.cjs");
  await writeFile(preloadPath, FEED_HOST_PRELOAD);
  const cycleId = "excluded-test";
  const startsAt = Date.now() - 30 * 86_400_000;
  const feedUpdatedAt = Date.now() - 60_000;

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
      response.end(JSON.stringify({ 21: feedUpdatedAt, 23: startsAt + 1000, 24: Date.now() + 3_600_000 }));
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
  const startsAt = Date.now() - 60_000;
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
