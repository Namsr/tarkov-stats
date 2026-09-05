import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  acquireWarmupLock,
  createRequestPacer,
  loadUpdatedVersions,
  requestCandidate,
  runWarmup,
  selectWarmupCandidates,
} from "../scripts/warmup-leaderboard-profiles.mjs";

test("the persistent process lock rejects overlap and is released by its owner", () => {
  const dir = mkdtempSync(join(tmpdir(), "leaderboard-warmup-lock-"));
  const path = join(dir, "warmup.lock");
  const release = acquireWarmupLock(path);
  assert.throws(() => acquireWarmupLock(path), /verify the recorded process/);
  release();
  acquireWarmupLock(path)();
});

test("warmup selection uses parser generations and keeps modes sequential", async () => {
  const dir = mkdtempSync(join(tmpdir(), "leaderboard-warmup-"));
  const playersPath = join(dir, "players.db");
  const progressionPath = join(dir, "progression.db");
  const checkpointPath = join(dir, "state.json");
  const players = new DatabaseSync(playersPath);
  players.exec(`
    CREATE TABLE players(aid INTEGER PRIMARY KEY,profile_updated_at INTEGER);
    CREATE TABLE mode_players(mode TEXT,aid INTEGER,profile_updated_at INTEGER,stats_json TEXT);
    CREATE TABLE excluded_players(aid INTEGER PRIMARY KEY);
    CREATE TABLE arena_mode_stats(aid INTEGER,arena_mode TEXT,upstream_version INTEGER,parser_version INTEGER);
    INSERT INTO players VALUES (1,100),(2,200),(10,1000);
    INSERT INTO mode_players VALUES ('pve',3,0,'{"pvpStatsParserVersion":0}'),
      ('pve',4,400,'{"pvpStatsParserVersion":1}'),('arena',5,500,'{}'),
      ('arena',6,600,'{}'),('arena',9,900,'{}');
    INSERT INTO arena_mode_stats VALUES
      (5,'overall',500,1),(5,'blastGang',500,1),(5,'teamFight',500,1),
      (5,'lastHero',500,1),(5,'checkpoint',500,1),(5,'shootOutDuo',500,1),
      (6,'overall',600,2),(6,'blastGang',600,2),(6,'teamFight',600,2),
      (6,'lastHero',600,2),(6,'checkpoint',600,2),(6,'shootOutDuo',600,2);
  `);
  const progression = new DatabaseSync(progressionPath);
  progression.exec(`
    CREATE TABLE progression_snapshots(id INTEGER PRIMARY KEY,mode TEXT,cycle_id TEXT,aid INTEGER,
      profile_updated_at INTEGER,stats_json TEXT);
    CREATE TABLE player_profiles(mode TEXT,cycle_id TEXT,aid INTEGER,profile_updated_at INTEGER,
      pvp_stats_parser_version INTEGER,confirmed_banned INTEGER);
    CREATE TABLE excluded_players(aid INTEGER PRIMARY KEY);
    INSERT INTO progression_snapshots VALUES (1,'regular','persistent',1,100,'{"pvpStatsParserVersion":0}'),
      (2,'regular','persistent',2,200,'{"pvpStatsParserVersion":1}'),
      (3,'regular','persistent',10,900,'{"pvpStatsParserVersion":1}');
    INSERT INTO player_profiles VALUES ('seasonal','s1',7,700,0,0),('seasonal','s1',8,800,1,0);
  `);
  progression.close();
  players.prepare("ATTACH DATABASE ? AS progression_scan").run(progressionPath);
  const candidates = selectWarmupCandidates(players, "s1", new Map([[3, 300]]));
  assert.deepEqual(candidates.map(({ mode, aid }) => [mode, aid]), [
    ["regular", 1], ["regular", 10], ["pve", 3], ["arena", 5], ["arena", 9], ["pvp-season", 7],
  ]);

  const requested = [];
  const first = await runWarmup({
    candidates, checkpointPath, maxProfiles: 1,
    request: async (candidate) => { requested.push(candidate.mode); return { kind: "skip", outcome: "not_found" }; },
  });
  assert.equal(first.bounded, true);
  assert.deepEqual(requested, ["regular"]);
  const second = await runWarmup({
    candidates, checkpointPath, maxProfiles: 10,
    request: async (candidate) => { requested.push(candidate.mode); return { kind: "completed", outcome: "ok" }; },
  });
  assert.equal(second.bounded, false);
  assert.deepEqual(requested, ["regular", "regular", "pve", "arena", "arena", "pvp-season"]);

  let stop = false;
  const stoppedRequests = [];
  const stopped = await runWarmup({
    candidates, checkpointPath: join(dir, "stopped.json"), maxProfiles: 10, shouldStop: () => stop,
    request: async (candidate) => {
      stoppedRequests.push(candidate.mode);
      stop = true;
      return { kind: "completed", outcome: "ok" };
    },
  });
  assert.equal(stopped.stopped, true);
  assert.deepEqual(stoppedRequests, ["regular"]);
  players.close();
});

test("one pacer spaces every request start by at least one second", async () => {
  let now = 10_000;
  const waits = [];
  const pace = createRequestPacer({ now: () => now, sleep: async (ms) => { waits.push(ms); now += ms; } });
  assert.equal(await pace(), 10_000);
  now += 250;
  assert.equal(await pace(), 11_000);
  now += 1_500;
  assert.equal(await pace(), 12_500);
  assert.deepEqual(waits, [750]);
});

test("PvE versions are read through the identifying JSON helper boundary", async () => {
  let init;
  const versions = await loadUpdatedVersions("https://players.tarkov.dev/pve/updated.json", async (_url, requestInit) => {
    init = requestInit;
    return new Response('{"3":300,"bad":"nope"}');
  });
  assert.equal(init.cache, "no-store");
  assert.equal(versions.get(3), 300_000);
  assert.equal(versions.size, 1);
});

test("409 retries through the global pacer while an uncertain timeout stops the run", async () => {
  const candidate = { mode: "regular", aid: 1, sourceVersion: 100 };
  let paced = 0;
  let calls = 0;
  const recovered = await requestCandidate(candidate, {
    baseUrl: "http://127.0.0.1:3000", secret: "x".repeat(32), maxRetries: 1, timeoutMs: 30_000,
    pace: async () => { paced += 1; }, sleep: async () => {},
    fetch: async () => new Response(JSON.stringify({ state: "duplicate" }), { status: ++calls === 1 ? 409 : 200 }),
  });
  assert.equal(recovered.kind, "completed");
  assert.equal(paced, 2);

  const terminal = await requestCandidate({ mode: "pve", aid: 2, sourceVersion: 200 }, {
    baseUrl: "http://127.0.0.1:3000", secret: "x".repeat(32), maxRetries: 0, timeoutMs: 30_000,
    pace: async () => {}, sleep: async () => {},
    fetch: async () => new Response(JSON.stringify({ state: "skipped_before_cutoff" }), { status: 200 }),
  });
  assert.deepEqual(terminal, { kind: "skip", outcome: "skipped_before_cutoff", attempts: 1 });

  let timedCalls = 0;
  await assert.rejects(requestCandidate(candidate, {
    baseUrl: "http://127.0.0.1:3000", secret: "x".repeat(32), maxRetries: 3, timeoutMs: 1,
    pace: async () => {}, sleep: async () => {},
    fetch: (_url, init) => new Promise((_resolve, reject) => {
      timedCalls += 1;
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }),
  }), /stopping to avoid overlapping/);
  assert.equal(timedCalls, 1);
});
