import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { parseArenaProfileStats } from "../lib/tarkov-api.ts";
import { ARENA_PARSER_VERSION, initializeArenaSchema, upsertArenaSqlite } from "../lib/arena/storage.ts";
import {
  beginAveragePublication,
  getAveragePublicationStates,
  markAveragePublicationDirty,
  publishAverageScope,
  resetAveragePublicationForTests,
} from "../lib/average-publication.ts";

const execFileAsync = promisify(execFile);
const secret = "test-secret-that-is-at-least-32-characters";

function launch(dbPath, baseUrl, feedUrl, maxCompleted = null, concurrency = 1, environment = {}) {
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
      ARENA_PLAYER_INDEX_URL: new URL("/arena/index.json", feedUrl).href,
      ARENA_PROFILE_SYNC_BASE_URL: baseUrl,
      ARENA_PROFILE_SYNC_RPS: "20",
      ARENA_PROFILE_SYNC_CONCURRENCY: String(concurrency),
      ARENA_PROFILE_SYNC_MAX_RETRIES: "0",
      ARENA_PROFILE_SYNC_MAX_COMPLETED: maxCompleted == null ? "" : String(maxCompleted),
      ...environment,
    },
  });
}

function summaryFrom(stdout) {
  const line = stdout.split("\n").find((entry) => entry.includes(" SUMMARY "));
  assert.ok(line, "collector emits its summary");
  return JSON.parse(line.slice(line.indexOf(" SUMMARY ") + " SUMMARY ".length));
}

function migrationSummaryFrom(stdout) {
  const line = stdout.split("\n").find((entry) => entry.includes(" MIGRATION_SUMMARY "));
  assert.ok(line, "collector emits its migration summary");
  return JSON.parse(line.slice(line.indexOf(" MIGRATION_SUMMARY ") + " MIGRATION_SUMMARY ".length));
}

test("average publication preserves invalidations newer than its compute watermark", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-average-publication-race-"));
  const previous = {
    SQLITE_PATH: process.env.SQLITE_PATH,
    AVERAGE_PUBLICATION_SQLITE_PATH: process.env.AVERAGE_PUBLICATION_SQLITE_PATH,
    AVERAGE_PUBLICATIONS_ENABLED: process.env.AVERAGE_PUBLICATIONS_ENABLED,
  };
  process.env.SQLITE_PATH = join(directory, "players.db");
  process.env.AVERAGE_PUBLICATION_SQLITE_PATH = join(directory, "average.db");
  process.env.AVERAGE_PUBLICATIONS_ENABLED = "true";
  resetAveragePublicationForTests();
  try {
    await markAveragePublicationDirty("arena", 200);
    await beginAveragePublication("arena", 100);
    await publishAverageScope("arena", new Map([["arena", { value: 1 }]]), 100, 300);
    assert.equal((await getAveragePublicationStates()).find((state) => state.scope === "arena")?.dirtyAt, 200);

    await markAveragePublicationDirty("pve", 50);
    await beginAveragePublication("pve", 100);
    await publishAverageScope("pve", new Map([["pve", { value: 1 }]]), 100, 300);
    assert.equal((await getAveragePublicationStates()).find((state) => state.scope === "pve")?.dirtyAt, null);
  } finally {
    resetAveragePublicationForTests();
    if (previous.SQLITE_PATH === undefined) delete process.env.SQLITE_PATH;
    else process.env.SQLITE_PATH = previous.SQLITE_PATH;
    if (previous.AVERAGE_PUBLICATION_SQLITE_PATH === undefined) delete process.env.AVERAGE_PUBLICATION_SQLITE_PATH;
    else process.env.AVERAGE_PUBLICATION_SQLITE_PATH = previous.AVERAGE_PUBLICATION_SQLITE_PATH;
    if (previous.AVERAGE_PUBLICATIONS_ENABLED === undefined) delete process.env.AVERAGE_PUBLICATIONS_ENABLED;
    else process.env.AVERAGE_PUBLICATIONS_ENABLED = previous.AVERAGE_PUBLICATIONS_ENABLED;
    await rm(directory, { recursive: true, force: true });
  }
});

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
    CREATE TABLE arena_mode_stats (
      aid INTEGER NOT NULL,
      arena_mode TEXT NOT NULL,
      upstream_version INTEGER NOT NULL,
      parser_version INTEGER NOT NULL,
      PRIMARY KEY (aid, arena_mode)
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
  for (const mode of ["overall", "teamFight", "lastHero", "checkpoint", "blastGang", "shootOutDuo"]) {
    players.prepare(`INSERT INTO arena_mode_stats
      (aid, arena_mode, upstream_version, parser_version) VALUES (2, ?, ?, ?)`)
      .run(mode, initial, ARENA_PARSER_VERSION);
  }
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
    for (const mode of ["overall", "teamFight", "lastHero", "checkpoint", "blastGang", "shootOutDuo"]) {
      players.prepare(`INSERT INTO arena_mode_stats
        (aid, arena_mode, upstream_version, parser_version) VALUES (?, ?, ?, ?)
        ON CONFLICT(aid, arena_mode) DO UPDATE SET upstream_version = excluded.upstream_version,
          parser_version = excluded.parser_version
      `).run(body.aid, mode, body.expectedUpdatedAt, body.schemaVersion);
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      state: "updated",
      profileUpdatedAt: body.expectedUpdatedAt,
      schemaVersion: body.schemaVersion,
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const feedUrl = `${baseUrl}/arena/updated.json`;

  try {
    const firstRun = await launch(dbPath, baseUrl, feedUrl);
    const firstSummary = summaryFrom(firstRun.stdout);
    assert.equal(firstSummary.indexCurrent, 3, "only all six current-parser rows count as covered");
    assert.equal(firstSummary.indexMissing, 1, "not-found indexed accounts remain outside coverage");
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
    players.prepare("UPDATE arena_mode_stats SET parser_version = 0 WHERE aid = 2").run();
    feed = { ...feed, 6: initial + 400 };
    const secondRun = await launch(dbPath, baseUrl, feedUrl);
    const secondSummary = summaryFrom(secondRun.stdout);
    assert.deepEqual(calls.slice(callsAfterFirstRun), [6]);
    assert.equal(secondSummary.deferredOldParser, 2);
    assert.equal(players.prepare(
      "SELECT status FROM arena_profile_sync_queue WHERE aid = 3"
    ).get().status, "not_found");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    players.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Arena profile sync refreshes a stale index before reading updated.json", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-profile-sync-daily-index-"));
  const dbPath = join(directory, "players.db");
  const players = new DatabaseSync(dbPath);
  players.exec(`
    CREATE TABLE mode_players (
      mode TEXT NOT NULL, aid INTEGER NOT NULL, profile_updated_at INTEGER DEFAULT 0,
      fetched_at INTEGER NOT NULL, stats_json TEXT NOT NULL, achievements TEXT,
      PRIMARY KEY (mode, aid)
    );
    CREATE TABLE arena_mode_stats (
      aid INTEGER NOT NULL, arena_mode TEXT NOT NULL, upstream_version INTEGER NOT NULL,
      parser_version INTEGER NOT NULL, PRIMARY KEY (aid, arena_mode)
    );
    CREATE TABLE excluded_players (aid INTEGER PRIMARY KEY);
    CREATE TABLE arena_player_index (
      mode TEXT NOT NULL, aid INTEGER NOT NULL, nickname TEXT NOT NULL,
      nickname_lower TEXT NOT NULL, synced_at INTEGER NOT NULL,
      PRIMARY KEY (mode, aid)
    );
    INSERT INTO arena_player_index (mode, aid, nickname, nickname_lower, synced_at)
      VALUES ('arena', 1, 'OldName', 'oldname', 1);
  `);
  let indexRequests = 0;
  let updatedRequests = 0;
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith("/arena/index.json")) {
      indexRequests += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ 1: "CurrentName", 2: "NewName" }));
      return;
    }
    if (request.url?.startsWith("/arena/updated.json")) {
      updatedRequests += 1;
      response.setHeader("content-type", "application/json");
      response.end("{}");
      return;
    }
    if (request.url === "/api/operator/profile-refresh/sync") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ state: "not_found" }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const run = await launch(dbPath, baseUrl, `${baseUrl}/arena/updated.json`);
    const summary = summaryFrom(run.stdout);
    assert.equal(summary.index.checked, true);
    assert.equal(indexRequests, 1);
    assert.equal(updatedRequests, 1);
    assert.deepEqual(players.prepare("SELECT aid, nickname FROM arena_player_index ORDER BY aid").all()
      .map((row) => ({ ...row })), [
      { aid: 1, nickname: "CurrentName" },
      { aid: 2, nickname: "NewName" },
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    players.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Arena profile sync caps successful completions, not errors, and resumes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-profile-sync-cap-"));
  const dbPath = join(directory, "players.db");
  const players = new DatabaseSync(dbPath);
  players.exec(`
    CREATE TABLE mode_players (
      mode TEXT NOT NULL, aid INTEGER NOT NULL, profile_updated_at INTEGER DEFAULT 0,
      fetched_at INTEGER NOT NULL, stats_json TEXT NOT NULL, achievements TEXT,
      PRIMARY KEY (mode, aid)
    );
    CREATE TABLE arena_mode_stats (
      aid INTEGER NOT NULL,
      arena_mode TEXT NOT NULL,
      upstream_version INTEGER NOT NULL,
      parser_version INTEGER NOT NULL,
      PRIMARY KEY (aid, arena_mode)
    );
    CREATE TABLE excluded_players (aid INTEGER PRIMARY KEY);
    CREATE TABLE arena_player_index (
      mode TEXT NOT NULL, aid INTEGER NOT NULL, nickname TEXT NOT NULL,
      nickname_lower TEXT NOT NULL, synced_at INTEGER NOT NULL,
      PRIMARY KEY (mode, aid)
    );
  `);
  const insertIndex = players.prepare(`
    INSERT INTO arena_player_index (mode, aid, nickname, nickname_lower, synced_at)
    VALUES ('arena', ?, ?, ?, ?)
  `);
  for (const aid of [1, 2, 3, 4]) {
    const nickname = `Player${aid}`;
    insertIndex.run(aid, nickname, nickname.toLowerCase(), Date.now());
  }

  let failingAid = 1;
  const calls = [];
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith("/arena/updated.json")) {
      response.setHeader("content-type", "application/json");
      response.end("{}");
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
    if (body.aid === failingAid) {
      response.writeHead(500).end("temporary failure");
      return;
    }
    players.prepare(`
      INSERT INTO mode_players (mode, aid, profile_updated_at, fetched_at, stats_json, achievements)
      VALUES ('arena', ?, ?, ?, '{}', '')
      ON CONFLICT(mode, aid) DO UPDATE SET profile_updated_at = excluded.profile_updated_at,
        fetched_at = excluded.fetched_at
    `).run(body.aid, body.expectedUpdatedAt, Date.now());
    for (const mode of ["overall", "teamFight", "lastHero", "checkpoint", "blastGang", "shootOutDuo"]) {
      players.prepare(`INSERT INTO arena_mode_stats
        (aid, arena_mode, upstream_version, parser_version) VALUES (?, ?, ?, ?)`)
        .run(body.aid, mode, body.expectedUpdatedAt, body.schemaVersion);
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      state: "updated",
      profileUpdatedAt: body.expectedUpdatedAt,
      schemaVersion: body.schemaVersion,
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const feedUrl = `${baseUrl}/arena/updated.json`;

  try {
    const cappedRun = await launch(dbPath, baseUrl, feedUrl, 2);
    const cappedSummary = summaryFrom(cappedRun.stdout);
    assert.equal(cappedSummary.attempted, 3);
    assert.equal(cappedSummary.completed, 2);
    assert.equal(cappedSummary.errors, 1, "the failed profile does not consume the completion cap");
    assert.equal(cappedSummary.stopReason, "max_completed");
    assert.deepEqual(calls, [1, 2, 3]);
    assert.deepEqual(players.prepare(
      "SELECT aid, status FROM arena_profile_sync_queue ORDER BY aid"
    ).all().map((row) => ({ aid: Number(row.aid), status: row.status })), [
      { aid: 1, status: "error" },
      { aid: 2, status: "completed" },
      { aid: 3, status: "completed" },
      { aid: 4, status: "pending" },
    ]);

    failingAid = null;
    const resumedRun = await launch(dbPath, baseUrl, feedUrl, 2);
    const resumedSummary = summaryFrom(resumedRun.stdout);
    assert.equal(resumedSummary.completed, 2);
    assert.equal(resumedSummary.stopReason, "max_completed");
    assert.deepEqual(calls.slice(3), [1, 4]);
    assert.deepEqual(players.prepare(
      "SELECT aid, status FROM arena_profile_sync_queue ORDER BY aid"
    ).all().map((row) => ({ aid: Number(row.aid), status: row.status })), [
      { aid: 1, status: "completed" },
      { aid: 2, status: "completed" },
      { aid: 3, status: "completed" },
      { aid: 4, status: "completed" },
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    players.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Arena collector runs bounded concurrent refreshes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-profile-sync-concurrency-"));
  const dbPath = join(directory, "players.db");
  const players = new DatabaseSync(dbPath);
  players.exec(`
    CREATE TABLE mode_players (
      mode TEXT NOT NULL, aid INTEGER NOT NULL, profile_updated_at INTEGER DEFAULT 0,
      fetched_at INTEGER NOT NULL, stats_json TEXT NOT NULL, achievements TEXT,
      PRIMARY KEY (mode, aid)
    );
    CREATE TABLE arena_mode_stats (
      aid INTEGER NOT NULL,
      arena_mode TEXT NOT NULL,
      upstream_version INTEGER NOT NULL,
      parser_version INTEGER NOT NULL,
      PRIMARY KEY (aid, arena_mode)
    );
    CREATE TABLE excluded_players (aid INTEGER PRIMARY KEY);
    CREATE TABLE arena_player_index (
      mode TEXT NOT NULL, aid INTEGER NOT NULL, nickname TEXT NOT NULL,
      nickname_lower TEXT NOT NULL, synced_at INTEGER NOT NULL,
      PRIMARY KEY (mode, aid)
    );
  `);
  const insert = players.prepare(`
    INSERT INTO arena_player_index (mode, aid, nickname, nickname_lower, synced_at)
    VALUES ('arena', ?, ?, ?, ?)
  `);
  for (let aid = 1; aid <= 4; aid += 1) insert.run(aid, `Player${aid}`, `player${aid}`, Date.now());

  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith("/arena/updated.json")) {
      response.end("{}");
      return;
    }
    if (request.url !== "/api/operator/profile-refresh/sync") {
      response.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    for (const mode of ["overall", "teamFight", "lastHero", "checkpoint", "blastGang", "shootOutDuo"]) {
      players.prepare(`INSERT INTO arena_mode_stats (aid, arena_mode, upstream_version, parser_version)
        VALUES (?, ?, ?, ?) ON CONFLICT (aid, arena_mode) DO UPDATE SET
        upstream_version = excluded.upstream_version, parser_version = excluded.parser_version`)
        .run(body.aid, mode, body.expectedUpdatedAt, body.schemaVersion);
    }
    calls += 1;
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 75));
    active -= 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      state: "updated",
      profileUpdatedAt: body.expectedUpdatedAt,
      schemaVersion: body.schemaVersion,
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const capped = summaryFrom((await launch(
      dbPath, baseUrl, `${baseUrl}/arena/updated.json`, 1, 2
    )).stdout);
    assert.equal(capped.completed, 1, JSON.stringify(capped));
    assert.equal(capped.stopReason, "max_completed");
    assert.equal(calls, 1);
    const run = await launch(dbPath, baseUrl, `${baseUrl}/arena/updated.json`, null, 2);
    const summary = summaryFrom(run.stdout);
    assert.equal(summary.completed, 3);
    assert.equal(calls, 4);
    assert.equal(maxActive, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    players.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Arena collector waits for every worker after a fatal error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-profile-sync-fatal-"));
  const dbPath = join(directory, "players.db");
  const players = new DatabaseSync(dbPath);
  players.exec(`
    CREATE TABLE mode_players (
      mode TEXT NOT NULL, aid INTEGER NOT NULL, profile_updated_at INTEGER DEFAULT 0,
      fetched_at INTEGER NOT NULL, stats_json TEXT NOT NULL, achievements TEXT,
      PRIMARY KEY (mode, aid)
    );
    CREATE TABLE arena_mode_stats (
      aid INTEGER NOT NULL,
      arena_mode TEXT NOT NULL,
      upstream_version INTEGER NOT NULL,
      parser_version INTEGER NOT NULL,
      PRIMARY KEY (aid, arena_mode)
    );
    CREATE TABLE excluded_players (aid INTEGER PRIMARY KEY);
    CREATE TABLE arena_player_index (
      mode TEXT NOT NULL, aid INTEGER NOT NULL, nickname TEXT NOT NULL,
      nickname_lower TEXT NOT NULL, synced_at INTEGER NOT NULL,
      PRIMARY KEY (mode, aid)
    );
    INSERT INTO arena_player_index (mode, aid, nickname, nickname_lower, synced_at)
    VALUES ('arena', 1, 'One', 'one', 1), ('arena', 2, 'Two', 'two', 1);
  `);
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith("/arena/updated.json")) {
      response.end("{}");
      return;
    }
    if (request.url !== "/api/operator/profile-refresh/sync") {
      response.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (Number(body.aid) === 1) {
      response.writeHead(401).end("unauthorized");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      state: "updated",
      profileUpdatedAt: body.expectedUpdatedAt,
      schemaVersion: body.schemaVersion,
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const startedAt = Date.now();
    let failure;
    try {
      await launch(dbPath, baseUrl, `${baseUrl}/arena/updated.json`, null, 2);
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    assert.ok(Date.now() - startedAt >= 140);
    assert.doesNotMatch(String(failure.stderr ?? ""), /database.*closed|invalid state/i);
    assert.equal(players.prepare(
      "SELECT status FROM arena_profile_sync_queue WHERE aid = 2"
    ).get().status, "completed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    players.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Arena collector migrates recoverable v3 profiles offline and networks only unrecoverable rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-profile-sync-v3-migration-"));
  const dbPath = join(directory, "players.db");
  const players = new DatabaseSync(dbPath);
  players.exec(`
    CREATE TABLE mode_players (
      mode TEXT NOT NULL, aid INTEGER NOT NULL, profile_updated_at INTEGER DEFAULT 0,
      fetched_at INTEGER NOT NULL, stats_json TEXT NOT NULL, achievements TEXT,
      PRIMARY KEY (mode, aid)
    );
    CREATE TABLE excluded_players (aid INTEGER PRIMARY KEY);
  `);
  initializeArenaSchema(players);
  players.exec(`
    CREATE TABLE arena_player_index (
      mode TEXT NOT NULL, aid INTEGER NOT NULL, nickname TEXT NOT NULL,
      nickname_lower TEXT NOT NULL, synced_at INTEGER NOT NULL,
      PRIMARY KEY (mode, aid)
    );
    CREATE TABLE arena_profile_sync_queue (
      aid INTEGER PRIMARY KEY, feed_updated_at INTEGER NOT NULL, schema_version INTEGER NOT NULL,
      status TEXT NOT NULL, attempts INTEGER NOT NULL, http_status INTEGER, error TEXT,
      last_run_id TEXT, updated_at INTEGER NOT NULL
    );
  `);

  const group = (matches, includeLosses = true) => ({ Counters: {
    GamesCount: matches,
    ArenaWins: matches ? Math.round(matches * 0.4) : 0,
    ...(includeLosses ? { ArenaLoses: matches ? matches - Math.round(matches * 0.4) : 0 } : {}),
    Kills: matches * 3,
    Deaths: matches * 2,
    Assists: matches,
    Headshots: matches,
    DamageDealt: matches * 100,
    RoundMvpCount: 0,
    MatchMvpCount: 0,
    KillsWithoutDeaths: 0,
    MaxKillsWithoutDeaths: 3,
    WinStreak: 0,
    LongestWinStreak: 2,
    LoseStreak: 0,
    LongestLoseStreak: 2,
  } });
  const zeroGroups = () => ({
    UnrankedOverall: group(0),
    UnrankedTeamFight: group(0),
    UnrankedLastHero: group(0),
    UnrankedCheckPoint: group(0),
    UnrankedBlastGang: group(0),
    UnrankedShootOutDuo: group(0),
  });
  const profile = (aid, updated, groups, totalInGameTime = 3600) => ({
    aid,
    updated,
    info: { nickname: `Player${aid}`, side: "PMC", experience: 1, prestigeLevel: 0 },
    stat: { totalInGameTime, arenaOverAllCounters: groups },
  });
  const storeV3 = (arenaProfile, fetchedAt) => {
    arenaProfile.parserVersion = 3;
    upsertArenaSqlite(players, arenaProfile, fetchedAt);
  };
  const backportMissingLosses = (arenaProfile, fetchedAt) => {
    storeV3(arenaProfile, fetchedAt);
    for (const table of ["arena_mode_stats", "arena_mode_stats_history"]) {
      for (const mode of ["overall", "teamFight"]) {
        const row = players.prepare(
          `SELECT raw_json FROM ${table} WHERE aid = ? AND arena_mode = ?`
        ).get(arenaProfile.aid, mode);
        const raw = JSON.parse(row.raw_json);
        raw.normalized.counters.losses = null;
        players.prepare(
          `UPDATE ${table} SET arena_losses = NULL, raw_json = ? WHERE aid = ? AND arena_mode = ?`
        ).run(JSON.stringify(raw), arenaProfile.aid, mode);
      }
    }
  };
  const timestamp = 1_800_000_000_000;
  const equivalent = parseArenaProfileStats(profile(1, timestamp, zeroGroups())).arenaProfile;
  const changed = parseArenaProfileStats(profile(2, timestamp, {
    UnrankedOverall: group(10, false),
    UnrankedTeamFight: group(10, false),
    UnrankedLastHero: group(0),
    UnrankedCheckPoint: group(0),
    UnrankedBlastGang: group(0),
    UnrankedShootOutDuo: group(0),
  })).arenaProfile;
  const nullHours = parseArenaProfileStats(profile(3, timestamp, zeroGroups(), null)).arenaProfile;
  const malformed = parseArenaProfileStats(profile(4, timestamp, zeroGroups())).arenaProfile;
  const mixed = parseArenaProfileStats(profile(5, timestamp, zeroGroups())).arenaProfile;
  const excluded = parseArenaProfileStats(profile(6, timestamp, zeroGroups())).arenaProfile;
  const oldParser = parseArenaProfileStats(profile(9, timestamp, zeroGroups())).arenaProfile;
  oldParser.parserVersion = 1;
  storeV3(equivalent, timestamp - 1000);
  backportMissingLosses(changed, timestamp - 1000);
  storeV3(nullHours, timestamp - 1000);
  storeV3(malformed, timestamp - 1000);
  storeV3(mixed, timestamp - 1000);
  storeV3(excluded, timestamp - 1000);
  upsertArenaSqlite(players, oldParser, timestamp - 1000);
  players.prepare("INSERT INTO excluded_players (aid) VALUES (6)").run();
  const malformedRaw = JSON.parse(players.prepare(
    "SELECT raw_json FROM arena_mode_stats WHERE aid = 4 AND arena_mode = 'overall'"
  ).get().raw_json);
  malformedRaw.sourceCounters = [];
  players.prepare("UPDATE arena_mode_stats SET raw_json = ? WHERE aid = 4 AND arena_mode = 'overall'")
    .run(JSON.stringify(malformedRaw));
  players.prepare("UPDATE arena_mode_stats SET parser_version = 2 WHERE aid = 5 AND arena_mode = 'teamFight'").run();
  players.prepare(`
    INSERT INTO arena_player_index (mode, aid, nickname, nickname_lower, synced_at)
    VALUES ('arena', 1, 'Player1', 'player1', ?), ('arena', 9, 'Player9', 'player9', ?)
  `).run(Date.now(), Date.now());
  players.prepare(`
    INSERT INTO arena_profile_sync_queue
      (aid, feed_updated_at, schema_version, status, attempts, http_status, error, last_run_id, updated_at)
    VALUES (8, ?, 3, 'pending', 0, NULL, NULL, NULL, ?)
  `).run(timestamp, Date.now());

  const calls = [];
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith("/arena/updated.json")) {
      response.end("{}");
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
    const refreshed = parseArenaProfileStats(profile(body.aid, timestamp, zeroGroups())).arenaProfile;
    upsertArenaSqlite(players, refreshed, timestamp);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      state: "updated",
      profileUpdatedAt: body.expectedUpdatedAt,
      schemaVersion: body.schemaVersion,
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const run = await launch(dbPath, baseUrl, `${baseUrl}/arena/updated.json`);
    const summary = summaryFrom(run.stdout);
    assert.deepEqual(summary.migration, {
      status: "complete",
      candidates: 5,
      migrated: 3,
      invalid: 1,
      mixed: 1,
      stale: 0,
      network: 2,
    });
    assert.deepEqual(calls, [4, 5]);
    assert.equal(summary.attempted, 2);
    assert.equal(summary.completed, 2);
    assert.equal(summary.deferredOldParser, 1);
    assert.equal(summary.indexCurrent, 1);
    assert.equal(players.prepare(
      "SELECT COUNT(*) AS n FROM arena_mode_stats WHERE aid = 9 AND parser_version = 1"
    ).get().n, 6);
    assert.equal(players.prepare(
      "SELECT status FROM arena_profile_sync_queue WHERE aid = 8"
    ).get().status, "pending");
    for (const aid of [1, 2, 3, 4, 5]) {
      assert.equal(players.prepare(
        "SELECT COUNT(*) AS n FROM arena_mode_stats WHERE aid = ? AND parser_version = 4"
      ).get(aid).n, 6);
    }
    assert.equal(players.prepare(
      "SELECT COUNT(*) AS n FROM arena_mode_stats WHERE aid = 6 AND parser_version = 3"
    ).get().n, 6);
    assert.equal(players.prepare(
      "SELECT COUNT(*) AS n FROM arena_mode_stats_history WHERE aid = 2 AND parser_version = 3"
    ).get().n, 6);
    assert.equal(players.prepare(
      "SELECT COUNT(*) AS n FROM arena_mode_stats_history WHERE aid = 2 AND parser_version = 4"
    ).get().n, 6);
    assert.deepEqual({ ...players.prepare(
      "SELECT games_count, arena_wins, arena_losses, win_rate FROM arena_mode_stats WHERE aid = 2 AND arena_mode = 'overall'"
    ).get() }, {
      games_count: 10,
      arena_wins: 4,
      arena_losses: 6,
      win_rate: 40,
    });
    assert.equal(players.prepare(
      "SELECT fetched_at FROM arena_mode_stats WHERE aid = 2 AND arena_mode = 'overall'"
    ).get().fetched_at, timestamp - 1000);
    assert.equal(players.prepare(
      "SELECT COUNT(*) AS n FROM arena_profile_sync_queue WHERE aid IN (1, 2)"
    ).get().n, 0);
    const second = summaryFrom((await launch(dbPath, baseUrl, `${baseUrl}/arena/updated.json`)).stdout);
    assert.equal(second.migration.status, "already_complete");
    assert.equal(second.attempted, 0);
    assert.deepEqual(calls, [4, 5]);

    const lateChanged = parseArenaProfileStats(profile(7, timestamp, {
      UnrankedOverall: group(10, false),
      UnrankedTeamFight: group(10, false),
      UnrankedLastHero: group(0),
      UnrankedCheckPoint: group(0),
      UnrankedBlastGang: group(0),
      UnrankedShootOutDuo: group(0),
    })).arenaProfile;
    backportMissingLosses(lateChanged, timestamp - 1000);
    players.prepare("DELETE FROM arena_profile_sync_meta WHERE key = 'offline_v3_to_v4_complete'").run();
    const invalidPublicationPath = join(directory, "not-sqlite.db");
    await writeFile(invalidPublicationPath, "not sqlite");
    const failed = await launch(dbPath, baseUrl, `${baseUrl}/arena/updated.json`, null, 1, {
      NODE_ENV: "production",
      AVERAGE_PUBLICATIONS_ENABLED: "true",
      AVERAGE_PUBLICATION_SQLITE_PATH: invalidPublicationPath,
    });
    const failedMigration = migrationSummaryFrom(failed.stdout);
    assert.equal(failedMigration.status, "interrupted", `${JSON.stringify(failedMigration)}\n${failed.stderr}`);
    assert.equal(players.prepare(
      "SELECT COUNT(*) AS n FROM arena_mode_stats WHERE aid = 7 AND parser_version = 4"
    ).get().n, 6);
    assert.equal(players.prepare(
      "SELECT value FROM arena_profile_sync_meta WHERE key = 'offline_v3_to_v4_publication_pending'"
    ).get().value, "1");
    assert.equal(players.prepare(
      "SELECT COUNT(*) AS n FROM arena_profile_sync_meta WHERE key = 'offline_v3_to_v4_complete'"
    ).get().n, 0);

    const recovered = summaryFrom((await launch(dbPath, baseUrl, `${baseUrl}/arena/updated.json`, null, 1, {
      NODE_ENV: "production",
      AVERAGE_PUBLICATIONS_ENABLED: "true",
      AVERAGE_PUBLICATION_SQLITE_PATH: join(directory, "average.db"),
    })).stdout);
    assert.equal(recovered.migration.status, "complete");
    assert.equal(recovered.migration.candidates, 0);
    assert.equal(players.prepare(
      "SELECT value FROM arena_profile_sync_meta WHERE key = 'dynamic_cache_version'"
    ).get().value, "2");
    assert.equal(players.prepare(
      "SELECT COUNT(*) AS n FROM arena_profile_sync_meta WHERE key = 'offline_v3_to_v4_publication_pending'"
    ).get().n, 0);
    assert.equal(players.prepare(
      "SELECT COUNT(*) AS n FROM arena_profile_sync_meta WHERE key = 'offline_v3_to_v4_complete'"
    ).get().n, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    players.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Arena collector migrates v2 profiles offline, targets only invalid rows, and keeps legacy queues isolated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-profile-sync-v2-migration-"));
  const dbPath = join(directory, "players.db");
  const players = new DatabaseSync(dbPath);
  players.exec(`
    CREATE TABLE mode_players (
      mode TEXT NOT NULL, aid INTEGER NOT NULL, profile_updated_at INTEGER DEFAULT 0,
      fetched_at INTEGER NOT NULL, stats_json TEXT NOT NULL, achievements TEXT,
      PRIMARY KEY (mode, aid)
    );
    CREATE TABLE excluded_players (aid INTEGER PRIMARY KEY);
  `);
  initializeArenaSchema(players);
  players.exec(`
    CREATE TABLE arena_player_index (
      mode TEXT NOT NULL, aid INTEGER NOT NULL, nickname TEXT NOT NULL,
      nickname_lower TEXT NOT NULL, synced_at INTEGER NOT NULL,
      PRIMARY KEY (mode, aid)
    );
    CREATE TABLE arena_profile_sync_queue (
      aid INTEGER PRIMARY KEY, feed_updated_at INTEGER NOT NULL, schema_version INTEGER NOT NULL,
      status TEXT NOT NULL, attempts INTEGER NOT NULL, http_status INTEGER, error TEXT,
      last_run_id TEXT, updated_at INTEGER NOT NULL
    );
  `);

  const timestamp = 1_800_000_000_000;
  const fetchedAt = timestamp - 1000;
  const group = (counters) => ({ Counters: counters });
  const groups = {
    UnrankedOverall: group({ GamesCount: 78 }),
    UnrankedTeamFight: group({ GamesCount: 3, ArenaWins: 3 }),
    UnrankedLastHero: group({ GamesCount: 1, ArenaLoses: 1 }),
    UnrankedCheckPoint: group({ GamesCount: 15, ArenaWins: 14, ArenaLoses: 1 }),
    UnrankedBlastGang: group({ GamesCount: 38, ArenaWins: 30, ArenaLoses: 8 }),
    UnrankedShootOutDuo: group({ GamesCount: 21, ArenaWins: 11, ArenaLoses: 10 }),
  };
  const profile = (aid, arenaGroups = groups) => ({
    aid,
    updated: timestamp,
    info: { nickname: `Player${aid}`, side: "PMC", experience: 1, prestigeLevel: 0 },
    stat: { totalInGameTime: 3600, arenaOverAllCounters: arenaGroups },
  });
  const store = (aid, parserVersion, arenaGroups = groups) => {
    const arenaProfile = parseArenaProfileStats(profile(aid, arenaGroups)).arenaProfile;
    arenaProfile.parserVersion = parserVersion;
    upsertArenaSqlite(players, arenaProfile, fetchedAt);
    return arenaProfile;
  };
  const backportV2Outcomes = (aid) => {
    for (const table of ["arena_mode_stats", "arena_mode_stats_history"]) {
      for (const mode of ["overall", "teamFight", "lastHero"]) {
        const row = players.prepare(
          `SELECT raw_json FROM ${table} WHERE aid = ? AND arena_mode = ?`
        ).get(aid, mode);
        const raw = JSON.parse(row.raw_json);
        raw.normalized.counters.wins = null;
        raw.normalized.counters.losses = null;
        raw.normalized.metrics.win_rate = null;
        players.prepare(`
          UPDATE ${table} SET arena_wins = NULL, arena_losses = NULL, win_rate = NULL, raw_json = ?
          WHERE aid = ? AND arena_mode = ?
        `).run(JSON.stringify(raw), aid, mode);
      }
    }
  };

  const validAid = 8045310;
  const invalidAid = 8045311;
  const legacyAid = 8045312;
  const oldQueueAid = 8045313;
  store(validAid, 2);
  backportV2Outcomes(validAid);
  store(invalidAid, 2);
  store(legacyAid, 1);
  const invalidRaw = JSON.parse(players.prepare(
    "SELECT raw_json FROM arena_mode_stats WHERE aid = ? AND arena_mode = 'overall'"
  ).get(invalidAid).raw_json);
  invalidRaw.sourceCounters = [];
  players.prepare(
    "UPDATE arena_mode_stats SET raw_json = ? WHERE aid = ? AND arena_mode = 'overall'"
  ).run(JSON.stringify(invalidRaw), invalidAid);
  for (const aid of [validAid, invalidAid, legacyAid]) {
    players.prepare(`
      INSERT INTO arena_player_index (mode, aid, nickname, nickname_lower, synced_at)
      VALUES ('arena', ?, ?, ?, ?)
    `).run(aid, `Player${aid}`, `player${aid}`, Date.now());
  }
  players.prepare(`
    INSERT INTO arena_profile_sync_queue
      (aid, feed_updated_at, schema_version, status, attempts, http_status, error, last_run_id, updated_at)
    VALUES (?, ?, 3, 'pending', 0, NULL, NULL, NULL, ?)
  `).run(oldQueueAid, timestamp, Date.now());

  const calls = [];
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith("/arena/updated.json")) {
      response.end("{}");
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
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      state: "updated",
      profileUpdatedAt: body.expectedUpdatedAt,
      schemaVersion: body.schemaVersion,
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const first = summaryFrom((await launch(dbPath, baseUrl, `${baseUrl}/arena/updated.json`)).stdout);
    assert.equal(first.migrations.v2.status, "complete");
    assert.equal(first.migrations.v2.candidates, 2);
    assert.equal(first.migrations.v2.migrated, 1);
    assert.equal(first.migrations.v2.invalid, 1);
    assert.equal(first.migrations.v2.network, 1);
    assert.equal(first.migrations.v3.status, "complete");
    assert.deepEqual(calls, [invalidAid]);
    assert.equal(first.attempted, 1);
    assert.equal(first.completed, 1);
    assert.equal(first.deferredOldParser, 2);
    assert.equal(players.prepare(
      "SELECT COUNT(*) AS n FROM arena_mode_stats WHERE aid = ? AND parser_version = 4"
    ).get(validAid).n, 6);
    assert.deepEqual({ ...players.prepare(`
      SELECT games_count, arena_wins, arena_losses, win_rate, fetched_at, parser_version
      FROM arena_mode_stats WHERE aid = ? AND arena_mode = 'overall'
    `).get(validAid) }, {
      games_count: 78,
      arena_wins: 58,
      arena_losses: 20,
      win_rate: 74.35897435897436,
      fetched_at: fetchedAt,
      parser_version: 4,
    });
    assert.equal(players.prepare(
      "SELECT COUNT(*) AS n FROM arena_mode_stats_history WHERE aid = ? AND parser_version = 2"
    ).get(validAid).n, 6);
    assert.equal(players.prepare(
      "SELECT COUNT(*) AS n FROM arena_mode_stats_history WHERE aid = ? AND parser_version = 4"
    ).get(validAid).n, 6);
    assert.equal(players.prepare(
      "SELECT schema_version, status FROM arena_profile_sync_queue WHERE aid = ?"
    ).get(invalidAid).schema_version, 4);
    assert.equal(players.prepare(
      "SELECT status FROM arena_profile_sync_queue WHERE aid = ?"
    ).get(oldQueueAid).status, "pending");
    assert.equal(players.prepare(
      "SELECT COUNT(*) AS n FROM arena_mode_stats WHERE aid = ? AND parser_version = 1"
    ).get(legacyAid).n, 6);

    const second = summaryFrom((await launch(dbPath, baseUrl, `${baseUrl}/arena/updated.json`)).stdout);
    assert.equal(second.migrations.v2.status, "already_complete");
    assert.equal(second.migrations.v3.status, "already_complete");
    assert.equal(second.attempted, 0);
    assert.deepEqual(calls, [invalidAid]);

    players.prepare("INSERT INTO excluded_players (aid) VALUES (?)").run(invalidAid);
    players.prepare("DELETE FROM arena_profile_sync_meta WHERE key = 'offline_v2_to_v4_complete'").run();
    players.prepare(`
      INSERT INTO arena_profile_sync_meta (key, value)
      VALUES ('offline_v2_to_v4_publication_pending', '1')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run();
    const invalidPublicationPath = join(directory, "not-sqlite.db");
    await writeFile(invalidPublicationPath, "not sqlite");
    const failed = await launch(dbPath, baseUrl, `${baseUrl}/arena/updated.json`, null, 1, {
      NODE_ENV: "production",
      AVERAGE_PUBLICATIONS_ENABLED: "true",
      AVERAGE_PUBLICATION_SQLITE_PATH: invalidPublicationPath,
    });
    const failedMigration = migrationSummaryFrom(failed.stdout);
    assert.equal(failedMigration.status, "interrupted");
    assert.equal(players.prepare(
      "SELECT COUNT(*) AS n FROM arena_profile_sync_meta WHERE key = 'offline_v2_to_v4_complete'"
    ).get().n, 0);
    assert.equal(players.prepare(
      "SELECT COUNT(*) AS n FROM arena_profile_sync_meta WHERE key = 'offline_v2_to_v4_publication_pending'"
    ).get().n, 1);

    const recovered = summaryFrom((await launch(dbPath, baseUrl, `${baseUrl}/arena/updated.json`, null, 1, {
      NODE_ENV: "production",
      AVERAGE_PUBLICATIONS_ENABLED: "true",
      AVERAGE_PUBLICATION_SQLITE_PATH: join(directory, "average.db"),
    })).stdout);
    assert.equal(recovered.migrations.v2.status, "complete");
    assert.equal(recovered.migrations.v3.status, "already_complete");
    assert.equal(players.prepare(
      "SELECT COUNT(*) AS n FROM arena_profile_sync_meta WHERE key = 'offline_v2_to_v4_publication_pending'"
    ).get().n, 0);
    assert.deepEqual(calls, [invalidAid]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    players.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Arena collector uses the JSON helper, two-request default, and an isolated queue", async () => {
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
  assert.match(source, /https:\/\/players\.tarkov\.dev\/arena\/index\.json/);
  assert.match(source, /INDEX_POLL_INTERVAL_MS = 24 \* 60 \* 60_000/);
  assert.match(source, /syncArenaIndex/);
  assert.match(source, /arena_profile_sync_(queue|meta|lease)/);
  assert.match(source, /requestsPerSecond: envNumber\("ARENA_PROFILE_SYNC_RPS", 2,/);
  assert.match(source, /concurrency: envInteger\("ARENA_PROFILE_SYNC_CONCURRENCY", 2, 1, 20\)/);
  assert.match(source, /ARENA_PROFILE_SYNC_MAX_RUN_MS", 25 \* 60_000, 60_000, 12 \* 60 \* 60_000/);
  assert.match(source, /migrateOfflineArenaV2Profiles/);
  assert.match(source, /migrateOfflineArenaV3Profiles/);
  assert.match(source, /migrateOfflineArenaProfiles/);
  assert.match(source, /classifyArenaV2Rows/);
  assert.match(source, /classifyArenaV3Rows/);
  assert.match(source, /offline_v2_to_v4_complete/);
  assert.match(source, /offline_v2_to_v4_publication_pending/);
  assert.ok(source.indexOf("migrateOfflineArenaV2Profiles(startedAt)") < source.indexOf("migrateOfflineArenaV3Profiles(startedAt)"));
  assert.ok(source.indexOf("migrateOfflineArenaV3Profiles(startedAt)") < source.indexOf("refreshIndexIfDue(startedAt)"));
  assert.match(source, /ARENA_PROFILE_SYNC_PROGRESS_EVERY/);
  assert.match(source, /maxCompleted: envOptionalPositiveInteger\("ARENA_PROFILE_SYNC_MAX_COMPLETED"\)/);
  assert.match(source, /arena_player_index/);
  assert.doesNotMatch(source, /DELETE FROM arena_player_index\b/);
  assert.match(source, /snapshot\.schemaVersion < config\.schemaVersion/);
  assert.match(source, /q\.schema_version = \?/);
  assert.match(source, /next\.get\(config\.schemaVersion, runId\)/);
  assert.match(source, /processQueue\(startedAt\)/);
  assert.match(source, /payload\?\.state === "not_found"/);
  assert.match(source, /verified_not_found_v1/);
  assert.match(source, /schema_version/);
  assert.match(source, /schemaVersion/);
  assert.match(packageSource, /"sync:arena-profiles": "node --experimental-strip-types --experimental-sqlite scripts\/sync-arena-profiles\.mjs"/);
  assert.match(dockerfile, /scripts\/sync-arena-profiles\.mjs/);
  assert.match(dockerfile, /lib\/arena\/storage\.ts/);
  assert.match(dockerfile, /types\/arena\.ts/);
  assert.match(service, /flock -n \/run\/tarkovstats-data-sync\.lock/);
  assert.match(service, /exec -T -e ARENA_PROFILE_SYNC_RPS=2 web/);
  assert.match(service, /scripts\/sync-arena-profiles\.mjs/);
  assert.match(timer, /Description=Hourly TarkovStats Arena profile sync/);
  assert.match(timer, /OnCalendar=\*-\*-\* \*:50:00 Europe\/Moscow/);
  assert.match(syncRoute, /isOperatorRequest/);
  assert.match(syncRoute, /isCurrentArenaSyncRun/);
  assert.match(syncRoute, /x-profile-refresh-run-id/);
  assert.match(syncRoute, /resolved\.payload\.mode === "arena"/);
  assert.match(syncRoute, /persistArenaProfile/);
  assert.match(syncRoute, /schemaVersion: ARENA_PARSER_VERSION/);
  assert.match(syncRoute, /revalidateTag\(ARENA_AVERAGE_CACHE_TAG, "max"\)/);
  assert.doesNotMatch(syncRoute, /warmAverageCaches|after\(/);
  assert.match(operatorProfile, /getPublicProfile\(aid, \{ force: true, mode, expectedUpdatedAt \}\)/);
});

test("Arena publication failures and deadline writes remain retryable", async () => {
  const [service, averageRoute, source, database] = await Promise.all([
    readFile("lib/arena/service.ts", "utf8"),
    readFile("app/api/average/route.ts", "utf8"),
    readFile("scripts/sync-arena-profiles.mjs", "utf8"),
    readFile("lib/db.ts", "utf8"),
  ]);
  assert.match(service, /if \(!\(await markAveragePublicationDirty\("arena"\)\)\)[\s\S]*throw new Error\("Arena average publication invalidation failed"\)/);
  assert.match(averageRoute, /dynamic_cache_version/);
  assert.match(averageRoute, /loadCachedArenaAverage\([\s\S]*cacheVersion/);
  assert.match(source, /offline_v3_to_v4_publication_pending/);
  assert.match(source, /runBudgetExpired\(startedAt\)/);
  assert.match(source, /signal: AbortSignal\.timeout\(Math\.max\(1, remainingMs\)\)/);
  assert.match(source, /loadUpdatedFeedWithRetry\(feedUrlForRun\(\), tracked, excluded, startedAt\)/);
  assert.match(source, /if \(waitMs >= remainingMs\)/);
  assert.match(source, /await writeTransaction\(\(\) => \{[\s\S]*DELETE FROM arena_profile_sync_queue/);
  assert.match(database, /const leaseNow = Date\.now\(\);[\s\S]*const age = leaseNow -/);
});

test("Arena conditional feed requests skip the body on 304 but keep index backfill", async () => {
  const directory = await mkdtemp(join(tmpdir(), "arena-profile-sync-304-"));
  const dbPath = join(directory, "players.db");
  const initial = 1_800_000_000_000;
  const players = new DatabaseSync(dbPath);
  players.exec(`
    CREATE TABLE mode_players (
      mode TEXT NOT NULL, aid INTEGER NOT NULL, profile_updated_at INTEGER DEFAULT 0,
      fetched_at INTEGER NOT NULL, stats_json TEXT NOT NULL, achievements TEXT,
      PRIMARY KEY (mode, aid)
    );
    CREATE TABLE arena_mode_stats (
      aid INTEGER NOT NULL,
      arena_mode TEXT NOT NULL,
      upstream_version INTEGER NOT NULL,
      parser_version INTEGER NOT NULL,
      PRIMARY KEY (aid, arena_mode)
    );
    CREATE TABLE excluded_players (aid INTEGER PRIMARY KEY);
    CREATE TABLE arena_player_index (
      mode TEXT NOT NULL, aid INTEGER NOT NULL, nickname TEXT NOT NULL,
      nickname_lower TEXT NOT NULL, synced_at INTEGER NOT NULL,
      PRIMARY KEY (mode, aid)
    );
    INSERT INTO arena_player_index (mode, aid, nickname, nickname_lower, synced_at)
      VALUES ('arena', 1, 'One', 'one', ${Date.now()}), ('arena', 2, 'Two', 'two', ${Date.now()});
  `);
  const feed = { 2: initial + 100 };
  const ETAG = '"test-arena-etag-1"';
  const seen = { hits: 0, conditional: 0, bodies: 0 };
  const calls = [];
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith("/arena/updated.json")) {
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
    if (request.url !== "/api/operator/profile-refresh/sync") {
      response.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    calls.push(body.aid);
    players.prepare(`
      INSERT INTO mode_players (mode, aid, profile_updated_at, fetched_at, stats_json, achievements)
      VALUES ('arena', ?, ?, ?, '{}', '')
      ON CONFLICT(mode, aid) DO UPDATE SET profile_updated_at = excluded.profile_updated_at,
        fetched_at = excluded.fetched_at
    `).run(body.aid, body.expectedUpdatedAt, Date.now());
    for (const mode of ["overall", "teamFight", "lastHero", "checkpoint", "blastGang", "shootOutDuo"]) {
      players.prepare(`INSERT INTO arena_mode_stats
        (aid, arena_mode, upstream_version, parser_version) VALUES (?, ?, ?, ?)
        ON CONFLICT(aid, arena_mode) DO UPDATE SET upstream_version = excluded.upstream_version,
          parser_version = excluded.parser_version
      `).run(body.aid, mode, body.expectedUpdatedAt, body.schemaVersion);
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      state: "updated",
      profileUpdatedAt: body.expectedUpdatedAt,
      schemaVersion: body.schemaVersion,
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const feedUrl = `${baseUrl}/arena/updated.json`;

  try {
    const first = summaryFrom((await launch(dbPath, baseUrl, feedUrl)).stdout);
    assert.equal(first.feedHttpStatus, 200);
    assert.equal(first.feedNotModified, false);
    assert.deepEqual(calls.sort((a, b) => a - b), [1, 2]);
    assert.equal(
      players.prepare("SELECT value FROM arena_profile_sync_meta WHERE key = 'feed_etag'").get().value,
      ETAG,
    );
    const completedAt = players.prepare(
      "SELECT aid, updated_at FROM arena_profile_sync_queue ORDER BY aid"
    ).all().map((row) => ({ ...row }));

    // Unchanged feed: revalidate, skip the body, keep the accepted watermark.
    const second = summaryFrom((await launch(dbPath, baseUrl, feedUrl)).stdout);
    assert.equal(seen.conditional, 1);
    assert.equal(seen.bodies, 1);
    assert.equal(second.feedNotModified, true);
    assert.equal(second.feedHttpStatus, 304);
    assert.equal(second.attempted, 0);
    assert.deepEqual(
      players.prepare("SELECT aid, updated_at FROM arena_profile_sync_queue ORDER BY aid")
        .all().map((row) => ({ ...row })),
      completedAt,
      "no-change runs must not rewrite already-satisfied queue rows",
    );

    // An index-covered account with a stats gap is still backfilled on 304.
    players.prepare("DELETE FROM arena_mode_stats WHERE aid = 2").run();
    calls.length = 0;
    const third = summaryFrom((await launch(dbPath, baseUrl, feedUrl)).stdout);
    assert.equal(third.feedNotModified, true);
    assert.deepEqual(calls, [2]);
    assert.equal(third.attempted, 1);
    assert.equal(third.completed, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    players.close();
    await rm(directory, { recursive: true, force: true });
  }
});
