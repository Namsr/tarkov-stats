import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("warmup time budget stops before another request without marking a signal stop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "warmup-budget-"));
  let now = 0;
  const result = await runWarmup({
    candidates: [{ mode: "regular", aid: 1, sourceVersion: 100 }, { mode: "regular", aid: 2, sourceVersion: 100 }],
    checkpointPath: join(dir, "state.json"), maxProfiles: 100, maxRunMs: 10, now: () => now,
    request: async () => { now = 10; return { kind: "completed" }; },
  });
  assert.equal(result.processed, 1);
  assert.equal(result.bounded, true);
  assert.equal(result.stopped, false);
});
import { DatabaseSync } from "node:sqlite";
import {
  acquireWarmupLock,
  createRequestPacer,
  loadUpdatedVersions,
  parseWarmupModes,
  requestCandidate,
  runWarmup,
  selectWarmupCandidates,
  warmupModesFromArgs,
} from "../scripts/warmup-leaderboard-profiles.mjs";

test("the persistent process lock rejects overlap and is released by its owner", () => {
  const dir = mkdtempSync(join(tmpdir(), "leaderboard-warmup-lock-"));
  const path = join(dir, "warmup.lock");
  const release = acquireWarmupLock(path);
  assert.throws(() => acquireWarmupLock(path), /verify the recorded process/);
  release();
  acquireWarmupLock(path)();
});

test("a zero-length checkpoint is named and replaced instead of failing every later run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "leaderboard-warmup-corrupt-"));
  const checkpointPath = join(dir, "state.json");
  writeFileSync(checkpointPath, "");
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (message) => { warnings.push(String(message)); };
  let result;
  try {
    result = await runWarmup({
      candidates: [{ mode: "regular", aid: 1, sourceVersion: 100 }],
      checkpointPath, maxProfiles: 10,
      request: async () => ({ kind: "completed", outcome: "ok" }),
    });
  } finally {
    console.warn = realWarn;
  }
  assert.equal(result.processed, 1);
  // main() and runWarmup each load the checkpoint, so a real run warns more than once.
  assert.ok(warnings.length >= 1, `expected a warning, got ${warnings.length}`);
  assert.ok(warnings.every((warning) => warning.includes(checkpointPath)), warnings.join("\n"));
  assert.equal(result.checkpointReset, true);
  const parsed = JSON.parse(readFileSync(checkpointPath, "utf8"));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.modes.regular.lastAid, 1, "the healed file records this run's progress, not just its shape");
  assert.equal(Array.isArray(parsed.skipped), false);
  assert.equal(typeof parsed.skipped, "object");
  assert.deepEqual(parsed.skipped, {}, "a fresh checkpoint carries no skipped records");
});

test("a checkpoint whose fields are null or arrays is refused instead of silently losing state", async () => {
  const request = async () => ({ kind: "completed", outcome: "ok" });
  // `typeof null === "object"` and an array is an object, so the shape guard has to exclude both by hand.
  for (const [label, contents] of [
    ["null fields", '{"version":1,"skipped":null,"modes":null}'],
    ["array fields", '{"version":1,"skipped":[],"modes":[]}'],
  ]) {
    const dir = mkdtempSync(join(tmpdir(), "leaderboard-warmup-shape-"));
    const checkpointPath = join(dir, "state.json");
    writeFileSync(checkpointPath, contents);
    await assert.rejects(runWarmup({
      candidates: [{ mode: "regular", aid: 1, sourceVersion: 100 }],
      checkpointPath, maxProfiles: 10, request,
    }), new RegExp(`unsupported leaderboard warmup checkpoint: ${checkpointPath.replaceAll("\\", "\\\\")}`), label);
    // The refused file is left untouched rather than half-rewritten as an array.
    assert.equal(readFileSync(checkpointPath, "utf8"), contents, label);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the checkpoint sweep takes a killed process's temp file and spares a live writer's", async () => {
  const dir = mkdtempSync(join(tmpdir(), "leaderboard-warmup-temp-"));
  const checkpointPath = join(dir, "state.json");
  const hourAgo = new Date(Date.now() - 3_600_000);
  const orphan = join(dir, "state.json.4242.tmp");
  const live = join(dir, "state.json.4343.tmp");
  const own = `${checkpointPath}.${process.pid}.tmp`;
  // A process killed between writeFileSync and renameSync leaves exactly this: a
  // foreign pid, no reader, and no owner left to remove it.
  writeFileSync(orphan, "{");
  utimesSync(orphan, hourAgo, hourAgo);
  // A peer that created its temp file a moment ago is still mid-write.
  writeFileSync(live, "{");
  writeFileSync(own, "{");
  utimesSync(own, hourAgo, hourAgo);
  // Refused by loadCheckpoint, so the run stops after the sweep and before its first save.
  writeFileSync(checkpointPath, '{"version":1,"skipped":null,"modes":null}');
  await assert.rejects(runWarmup({
    candidates: [], checkpointPath, maxProfiles: 10,
    request: async () => ({ kind: "completed", outcome: "ok" }),
  }), /unsupported leaderboard warmup checkpoint/);
  assert.equal(existsSync(orphan), false, "a temp file a killed process left is removed");
  assert.equal(existsSync(live), true, "a temp file a live peer is still writing is kept");
  assert.equal(existsSync(own), true, "this process never removes its own in-flight temp file");
  rmSync(dir, { recursive: true, force: true });
});

test("a run leaves no checkpoint temp file behind, including when the rename fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "leaderboard-warmup-leak-"));
  const checkpointPath = join(dir, "state.json");
  const temps = () => readdirSync(dir).filter((name) => name.endsWith(".tmp"));
  await runWarmup({
    candidates: [{ mode: "regular", aid: 1, sourceVersion: 100 }, { mode: "regular", aid: 2, sourceVersion: 100 }],
    checkpointPath, maxProfiles: 10,
    request: async () => ({ kind: "completed", outcome: "ok" }),
  });
  assert.deepEqual(temps(), []);

  // A directory where the checkpoint belongs: the write succeeds and the rename
  // cannot, which is the case a run that never cleans up would leak on.
  const blocked = join(dir, "blocked.json");
  mkdirSync(blocked);
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(runWarmup({
      candidates: [{ mode: "regular", aid: 1, sourceVersion: 100 }],
      checkpointPath: blocked, maxProfiles: 10,
      request: async () => ({ kind: "completed", outcome: "ok" }),
    }));
  } finally {
    console.warn = realWarn;
  }
  assert.deepEqual(temps(), [], "a save that could not rename deletes its own temp file");
  rmSync(dir, { recursive: true, force: true });
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
    ["regular", 1], ["regular", 10], ["pve", 3], ["arena", 5], ["arena", 6], ["arena", 9], ["pvp-season", 7],
  ]);
  assert.deepEqual(selectWarmupCandidates(players, "s1", new Map(), ["arena"])
    .map(({ mode, aid }) => [mode, aid]), [["arena", 5], ["arena", 6], ["arena", 9]]);
  assert.deepEqual(selectWarmupCandidates(players, "s1", new Map(), ["regular", "arena"], {
    limitPerMode: 1, checkpoint: { modes: { regular: { lastAid: 1 }, arena: { lastAid: 5 } } },
  }).map(({ mode, aid }) => [mode, aid]), [["regular", 10], ["arena", 6]]);
  assert.deepEqual(selectWarmupCandidates(players, "s1", new Map(), ["regular"], {
    limitPerMode: 1, checkpoint: { modes: { regular: { lastAid: 10 } } },
  }).map(({ aid }) => aid), [1], "cursor wraps instead of dropping earlier failures forever");

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
  assert.deepEqual(requested, ["regular", "regular", "pve", "arena", "arena", "arena", "pvp-season"]);

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

test("one pacer allows at most two request starts per second", async () => {
  let now = 10_000;
  const waits = [];
  const pace = createRequestPacer({ now: () => now, sleep: async (ms) => { waits.push(ms); now += ms; } });
  assert.equal(await pace(), 10_000);
  now += 250;
  assert.equal(await pace(), 10_500);
  now += 1_500;
  assert.equal(await pace(), 12_000);
  assert.deepEqual(waits, [250]);
});

test("mode filtering rejects typos and retains checkpoint state for other modes", async () => {
  assert.deepEqual(parseWarmupModes("arena,pve,arena"), ["pve", "arena"]);
  assert.throws(() => parseWarmupModes("arnea"));
  const dir = mkdtempSync(join(tmpdir(), "warmup-modes-"));
  const checkpointPath = join(dir, "state.json");
  const candidates = [
    { mode: "regular", aid: 1, sourceVersion: 100 },
    { mode: "arena", aid: 2, sourceVersion: 200 },
  ];
  const requested = [];
  const request = async (candidate) => {
    requested.push(candidate.mode);
    return { kind: "skip", outcome: "not_found" };
  };
  await runWarmup({ candidates, checkpointPath, modes: ["regular"], maxProfiles: Infinity, request });
  const result = await runWarmup({ candidates, checkpointPath, modes: ["arena"], maxProfiles: Infinity, request });
  assert.deepEqual(requested, ["regular", "arena"]);
  assert.equal(result.checkpoint.modes.regular.skipped, 1);
  assert.equal(result.checkpoint.modes.arena.skipped, 1);
  assert.equal(result.bounded, false);
});

test("the warmup modes flag accepts the space-separated form like the other scripts", () => {
  const previous = process.env.LEADERBOARD_WARMUP_MODES;
  process.env.LEADERBOARD_WARMUP_MODES = "pve";
  try {
    assert.deepEqual(warmupModesFromArgs(["--modes", "arena"]), ["arena"]);
    assert.deepEqual(warmupModesFromArgs(["--modes=arena"]), ["arena"]);
    assert.deepEqual(warmupModesFromArgs(["--mode", "arena"]), ["arena"]);
    assert.deepEqual(warmupModesFromArgs(["--mode=arena"]), ["arena"]);
    assert.deepEqual(warmupModesFromArgs(["--modes", "arena,pve"]), ["pve", "arena"]);
    assert.deepEqual(warmupModesFromArgs([]), ["pve"], "no flag keeps the environment default");
    assert.deepEqual(warmupModesFromArgs(["--modes", "--mode=arena"]), ["arena"], "a value-less flag falls back");
    assert.throws(() => warmupModesFromArgs(["--modes", "arnea"]), /expected modes from/);
  } finally {
    if (previous === undefined) delete process.env.LEADERBOARD_WARMUP_MODES;
    else process.env.LEADERBOARD_WARMUP_MODES = previous;
  }
});

test("a full run resumes terminal skips after failure and reaches the last mode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "warmup-resume-"));
  const checkpointPath = join(dir, "state.json");
  const candidates = Array.from({ length: 101 }, (_, index) => ({
    mode: "regular", aid: index + 1, sourceVersion: 100,
  }));
  candidates.push({ mode: "pvp-season", aid: 102, sourceVersion: 100, cycleId: "s1" });
  await assert.rejects(runWarmup({
    candidates, checkpointPath, maxProfiles: Infinity,
    request: async ({ aid }) => {
      if (aid === 2) throw new Error("container unavailable");
      return { kind: "skip", outcome: "not_found" };
    },
  }), /container unavailable/);
  const requested = [];
  const result = await runWarmup({
    candidates, checkpointPath, maxProfiles: Infinity,
    request: async ({ aid }) => { requested.push(aid); return { kind: "completed", outcome: "ok" }; },
  });
  assert.deepEqual(requested, Array.from({ length: 101 }, (_, index) => index + 2));
  assert.equal(result.bounded, false);
  assert.equal(result.checkpoint.modes.regular.lastError, null);
  assert.equal(result.checkpoint.modes["pvp-season"].completed, 1);
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

test("PvE feed retries a terminated partial stream without keeping partial versions", async () => {
  let calls = 0;
  const partial = () => {
    let pulls = 0;
    return new Response(new ReadableStream({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(new TextEncoder().encode('{"3":300,'));
        else controller.error(new TypeError("terminated"));
      },
    }));
  };
  const versions = await loadUpdatedVersions("https://players.tarkov.dev/pve/updated.json", {
    maxRetries: 1, timeoutMs: 30_000, sleep: async () => {},
    request: async () => ++calls === 1 ? partial() : new Response('{"4":400}'),
  });
  assert.deepEqual([...versions], [[4, 400_000]]);
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(loadUpdatedVersions("https://players.tarkov.dev/pve/updated.json", {
    maxRetries: 1, timeoutMs: 30_000, sleep: async () => {},
    request: async () => { calls += 1; return partial(); },
  }), /warmup updated feed failed after 2 attempts: TypeError: terminated/);
  assert.equal(calls, 2);
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
