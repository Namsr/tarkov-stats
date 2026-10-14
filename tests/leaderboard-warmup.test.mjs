import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

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
  let result;
  let parsed;
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (message) => { warnings.push(String(message)); };
  try {
    result = await runWarmup({
      candidates: [{ mode: "regular", aid: 1, sourceVersion: 100 }],
      checkpointPath, maxProfiles: 10,
      request: async () => ({ kind: "completed", outcome: "ok" }),
    });
    parsed = JSON.parse(readFileSync(checkpointPath, "utf8"));
    // The same reset seen again, the way main()'s pre-read and runWarmup see one
    // run's checkpoint. ops/profile-queue.sh frames stderr into the journal, and
    // two identical WARMUP_WARN lines is what a count-based alert fires on.
    writeFileSync(checkpointPath, "");
    await runWarmup({
      candidates: [{ mode: "regular", aid: 1, sourceVersion: 100 }],
      checkpointPath, maxProfiles: 10,
      request: async () => ({ kind: "completed", outcome: "ok" }),
    });
  } finally {
    console.warn = realWarn;
    // Guarded, so a failure in either run is what the report carries.
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* nothing holds this directory. */ }
  }
  assert.equal(result.processed, 1);
  assert.equal(warnings.length, 1, "one reset warns once per process, not once per read");
  assert.ok(warnings.every((warning) => warning.includes(checkpointPath)), warnings.join("\n"));
  assert.equal(result.checkpointReset, true);
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

test("the checkpoint sweep takes a killed process's temp file and spares everything else", async () => {
  const dir = mkdtempSync(join(tmpdir(), "leaderboard-warmup-temp-"));
  const checkpointPath = join(dir, "state.json");
  const hourAgo = new Date(Date.now() - 3_600_000);
  const stale = (name) => {
    const file = join(dir, name);
    writeFileSync(file, "{");
    utimesSync(file, hourAgo, hourAgo);
    return file;
  };
  const orphan = stale("state.json.4242.tmp");
  // A peer that created its temp file a moment ago is still mid-write.
  const live = join(dir, "state.json.4343.tmp");
  writeFileSync(live, "{");
  const own = stale(`state.json.${process.pid}.tmp`);
  // Neither of these is an orphaned pid temp: a dated copy an operator put here,
  // and a temp file belonging to a second checkpoint whose own name starts with
  // this one's. Both share the prefix, and only one shape is a pid temp.
  const dated = stale("state.json.20260906.tmp");
  const otherCheckpoint = stale("state.json.backup.json.999.tmp");
  // Refused by loadCheckpoint, so the run stops after the sweep and before its first save.
  writeFileSync(checkpointPath, '{"version":1,"skipped":null,"modes":null}');
  await assert.rejects(runWarmup({
    candidates: [], checkpointPath, maxProfiles: 10,
    request: async () => ({ kind: "completed", outcome: "ok" }),
  }), /unsupported leaderboard warmup checkpoint/);
  assert.equal(existsSync(orphan), false, "a temp file a killed process left is removed");
  assert.equal(existsSync(live), true, "a temp file a live peer is still writing is kept");
  assert.equal(existsSync(own), true, "this process never removes its own in-flight temp file");
  assert.equal(existsSync(dated), true, "a dated copy that is not a pid temp is not this sweep's to delete");
  assert.equal(existsSync(otherCheckpoint), true, "another checkpoint's temp file is not this sweep's to delete");
  rmSync(dir, { recursive: true, force: true });
});

test("a run leaves no checkpoint temp file behind, including when the rename fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "leaderboard-warmup-leak-"));
  const checkpointPath = join(dir, "state.json");
  const temps = () => readdirSync(dir).filter((name) => name.endsWith(".tmp"));
  // Seeded the way a killed process leaves one. A successful run renames its own
  // temp away anyway, so without this the assertion would hold on the unfixed
  // script and say nothing about the sweep.
  const orphan = join(dir, "state.json.4242.tmp");
  writeFileSync(orphan, "{");
  utimesSync(orphan, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
  await runWarmup({
    candidates: [{ mode: "regular", aid: 1, sourceVersion: 100 }, { mode: "regular", aid: 2, sourceVersion: 100 }],
    checkpointPath, maxProfiles: 10,
    request: async () => ({ kind: "completed", outcome: "ok" }),
  });
  assert.deepEqual(temps(), [], "the run sweeps what the last one left and leaves nothing of its own");

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

test("a checkpoint directory that does not exist fails on the write, not on the sweep", async () => {
  const dir = mkdtempSync(join(tmpdir(), "leaderboard-warmup-nodir-"));
  // The code alone cannot tell these apart: readdirSync on a missing directory
  // also reports ENOENT, so the syscall and the path are what separate this run's
  // write from the sweep's readdir swallowing its own.
  await assert.rejects(runWarmup({
    candidates: [{ mode: "regular", aid: 1, sourceVersion: 100 }],
    checkpointPath: join(dir, "absent", "state.json"), maxProfiles: 10,
    request: async () => ({ kind: "completed", outcome: "ok" }),
  }), (error) => {
    assert.equal(error.code, "ENOENT");
    assert.equal(error.syscall, "open", "the failure is this run's write, not the sweep's readdir");
    assert.equal(error.path, join(dir, "absent", `state.json.${process.pid}.tmp`));
    return true;
  });
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
      ('pve',4,400,'{"pvpStatsParserVersion":2}'),('pve',11,1100,'{"pvpStatsParserVersion":1}'),('arena',5,500,'{}'),
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
    INSERT INTO progression_snapshots VALUES (1,'regular','persistent',1,100,'{"pvpStatsParserVersion":1}'),
      (2,'regular','persistent',2,200,'{"pvpStatsParserVersion":2}'),
      (3,'regular','persistent',10,900,'{"pvpStatsParserVersion":2}');
    INSERT INTO player_profiles VALUES ('seasonal','s1',7,700,0,0),('seasonal','s1',8,800,1,0);
  `);
  progression.close();
  players.prepare("ATTACH DATABASE ? AS progression_scan").run(progressionPath);
  const candidates = selectWarmupCandidates(players, "s1", new Map([[3, 300]]));
  assert.deepEqual(candidates.map(({ mode, aid }) => [mode, aid]), [
    ["regular", 1], ["regular", 10], ["pve", 3], ["pve", 11], ["arena", 5], ["arena", 6], ["arena", 9], ["pvp-season", 7],
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
  assert.deepEqual(requested, ["regular", "regular", "pve", "pve", "arena", "arena", "arena", "pvp-season"]);

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

test("warmup selection reads only a bounded identity page and resumes scans with no candidates", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE players(aid INTEGER PRIMARY KEY, profile_updated_at INTEGER);
    CREATE TABLE excluded_players(aid INTEGER PRIMARY KEY);
    ATTACH DATABASE ':memory:' AS progression_scan;
    CREATE TABLE progression_scan.progression_snapshots
      (id INTEGER PRIMARY KEY, mode TEXT, cycle_id TEXT, aid INTEGER, profile_updated_at INTEGER, stats_json TEXT);
    CREATE INDEX progression_scan.latest_snapshot ON progression_snapshots(mode,cycle_id,aid,profile_updated_at,id);`);
  const insertPlayer = db.prepare("INSERT INTO players VALUES (?,100)");
  const insertSnapshot = db.prepare("INSERT INTO progression_scan.progression_snapshots VALUES (?,'regular','persistent',?,100,?)");
  for (let aid = 1; aid <= 1000; aid++) {
    insertPlayer.run(aid);
    insertSnapshot.run(aid, aid, JSON.stringify({ pvpStatsParserVersion: aid === 1 ? 1 : 2 }));
  }
  let reads = 0;
  db.function("json_valid", (value) => { reads++; return typeof value === "string" ? 1 : 0; });
  try {
    assert.deepEqual(selectWarmupCandidates(db, null, new Map(), ["regular"], { limitPerMode: 1 })
      .map(row => row.aid), [1]);
    assert.equal(reads, 1, "LIMIT must take effect before inspecting every saved JSON");
    db.exec(`UPDATE progression_scan.progression_snapshots SET stats_json = '{"pvpStatsParserVersion":2}' WHERE aid = 1;
      UPDATE progression_scan.progression_snapshots SET stats_json = '{"pvpStatsParserVersion":1}' WHERE aid = 3;`);
    reads = 0;
    let scanAid = 0;
    assert.deepEqual(selectWarmupCandidates(db, null, new Map(), ["regular"], {
      shouldStop: () => reads >= 2, onProgress: (_mode, aid) => { scanAid = aid; },
    }), []);
    assert.equal(scanAid, 2);
    assert.deepEqual(selectWarmupCandidates(db, null, new Map(), ["regular"], {
      checkpoint: { modes: { regular: { scanAid } } }, limitPerMode: 1,
    }).map(row => row.aid), [3]);
  } finally { db.close(); }
});

test("skip checkpoints invalidate Regular and PvE parser 1 while retaining Seasonal parser 1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "warmup-parser-modes-"));
  const checkpointPath = join(dir, "state.json");
  const candidates = [
    { mode: "regular", aid: 1, sourceVersion: 100 },
    { mode: "pve", aid: 2, sourceVersion: 200 },
    { mode: "pvp-season", cycleId: "s1", aid: 3, sourceVersion: 300 },
  ];
  writeFileSync(checkpointPath, JSON.stringify({ version: 1, modes: {}, skipped: {
    "regular:persistent:1:100:parser-1": { outcome: "not_found" },
    "pve:persistent:2:200:parser-1": { outcome: "not_found" },
    "pvp-season:s1:3:300:parser-1": { outcome: "not_found" },
  } }));
  const requested = [];
  const result = await runWarmup({ candidates, checkpointPath, maxProfiles: 10,
    request: async (candidate) => { requested.push(candidate.mode); return { kind: "completed", outcome: "ok" }; },
  });
  assert.deepEqual(requested, ["regular", "pve"]);
  assert.equal(result.processed, 2);
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

test("warmup deadline bounds retry waits and leaves an unprocessed candidate resumable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "warmup-retry-deadline-"));
  const checkpointPath = join(dir, "state.json");
  let requests = 0;
  const options = { baseUrl: "http://web:3000", secret: "x".repeat(32), maxRetries: 3,
    timeoutMs: 30_000, deadline: 500, now: () => 0, pace: async () => {},
    sleep: async () => { throw new Error("retry wait exceeds the remaining budget"); },
    fetch: async () => { requests++; return new Response("{}", { status: 409 }); } };
  const candidate = { mode: "regular", aid: 1, sourceVersion: 100 };
  try {
    const result = await runWarmup({ candidates: [candidate], checkpointPath, maxProfiles: 10,
      request: candidate => requestCandidate(candidate, options) });
    assert.equal(result.bounded, true);
    assert.equal(result.stopped, false);
    assert.equal(result.processed, 0);
    assert.equal(requests, 1);
    assert.deepEqual(result.checkpoint.skipped, {});
    const resumed = await runWarmup({ candidates: [candidate], checkpointPath, maxProfiles: 10,
      request: async () => ({ kind: "completed", outcome: "ok" }) });
    assert.equal(resumed.processed, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
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

test("bounded scans honor rotated modes across consecutive runs", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE players(aid INTEGER PRIMARY KEY, profile_updated_at INTEGER);
    CREATE TABLE mode_players(mode TEXT, aid INTEGER, profile_updated_at INTEGER, stats_json TEXT);
    CREATE TABLE excluded_players(aid INTEGER PRIMARY KEY);
    ATTACH DATABASE ':memory:' AS progression_scan;
    CREATE TABLE progression_scan.progression_snapshots
      (id INTEGER PRIMARY KEY, mode TEXT, cycle_id TEXT, aid INTEGER, profile_updated_at INTEGER, stats_json TEXT);
    INSERT INTO players VALUES (1,100),(2,100),(3,100),(4,100);
    INSERT INTO progression_scan.progression_snapshots VALUES
      (1,'regular','persistent',1,100,'{"pvpStatsParserVersion":2}'),
      (2,'regular','persistent',2,100,'{"pvpStatsParserVersion":2}'),
      (3,'regular','persistent',3,100,'{"pvpStatsParserVersion":2}'),
      (4,'regular','persistent',4,100,'{"pvpStatsParserVersion":2}');
    INSERT INTO mode_players VALUES ('pve',5,500,'{}');`);
  let visited = 0;
  const checkpoint = { modes: {}, nextMode: "regular" };
  const selected = [];
  try {
    for (let run = 0; run < 4; run++) {
      visited = 0;
      const modes = checkpoint.nextMode === "pve" ? ["pve", "regular"] : ["regular", "pve"];
      let lastMode;
      const candidates = selectWarmupCandidates(db, null, new Map(), modes, {
        checkpoint, limitPerMode: 1, shouldStop: () => visited >= 2,
        onProgress: (mode, aid) => { visited++; checkpoint.modes[mode] = { scanAid: aid }; lastMode = mode; },
      });
      selected.push(...candidates.map(row => row.mode));
      checkpoint.nextMode = candidates.length ? "regular" : modes[(modes.indexOf(lastMode) + 1) % modes.length];
    }
    assert.deepEqual(selected, ["pve", "pve"]);
  } finally { db.close(); }
});

test("PvE feed bounds headers, partial bodies and retry backoff by the deadline", async (t) => {
  for (const stage of ["headers", "body", "retry"]) {
    await t.test(stage, async () => {
      let calls = 0;
      let cancelled = false;
      const started = Date.now();
      await assert.rejects(loadUpdatedVersions("http://feed.test", {
        deadline: started + 100, timeoutMs: 30_000, maxRetries: 3,
        request: async (_url, { signal }) => {
          calls++;
          if (stage === "headers") return new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
          if (stage === "retry") return new Response("{}", { status: 503 });
          return new Response(new ReadableStream({
            start(controller) { controller.enqueue(new TextEncoder().encode('{"3":300,')); },
            cancel() { cancelled = true; },
          }));
        },
      }), { code: "WARMUP_BOUNDED" });
      assert.equal(calls, 1);
      assert.ok(Date.now() - started < 1000);
      if (stage === "body") assert.equal(cancelled, true);
    });
  }
});

test("PvE feed signals interrupt a partial body and a pending retry delay", async (t) => {
  for (const stage of ["body", "retry"]) {
    await t.test(stage, async () => {
      const controller = new AbortController();
      let calls = 0;
      const timer = setTimeout(() => controller.abort(), 50);
      const started = Date.now();
      try {
        await assert.rejects(loadUpdatedVersions("http://feed.test", {
          signal: controller.signal, maxRetries: 3, timeoutMs: 30_000,
          request: async () => {
            calls++;
            return stage === "retry" ? new Response("{}", { status: 503 })
              : new Response(new ReadableStream({
                start(stream) { stream.enqueue(new TextEncoder().encode('{"3":300,')); },
              }));
          },
        }), { code: "WARMUP_STOPPED" });
        assert.equal(calls, 1);
        assert.ok(Date.now() - started < 1000);
      } finally { clearTimeout(timer); }
    });
  }
});

async function warmupCliFixture(t, handler) {
  const dir = mkdtempSync(join(tmpdir(), "warmup-cli-"));
  const playersPath = join(dir, "players.db");
  const progressionPath = join(dir, "progression.db");
  const checkpointPath = join(dir, "state.json");
  const lockPath = join(dir, "warmup.lock");
  const players = new DatabaseSync(playersPath);
  players.exec(`CREATE TABLE players(aid INTEGER PRIMARY KEY,profile_updated_at INTEGER);
    CREATE TABLE mode_players(mode TEXT,aid INTEGER,profile_updated_at INTEGER,stats_json TEXT);
    CREATE TABLE excluded_players(aid INTEGER PRIMARY KEY);
    INSERT INTO players VALUES (1,100);
    INSERT INTO mode_players VALUES ('pve',2,0,'{}');`);
  players.close();
  const progression = new DatabaseSync(progressionPath);
  progression.exec(`CREATE TABLE progression_snapshots(id INTEGER PRIMARY KEY,mode TEXT,cycle_id TEXT,aid INTEGER,
    profile_updated_at INTEGER,stats_json TEXT);`);
  progression.close();
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  return { checkpointPath, lockPath, run: async (env = {}) => {
    const started = Date.now();
    const child = spawn(process.execPath, ["--experimental-strip-types", "--experimental-sqlite",
      "scripts/warmup-leaderboard-profiles.mjs"], { cwd: process.cwd(), env: {
        ...process.env, SQLITE_PATH: playersPath, PROGRESSION_SQLITE_PATH: progressionPath,
        LEADERBOARD_WARMUP_CHECKPOINT: checkpointPath, LEADERBOARD_WARMUP_LOCK: lockPath,
        PROFILE_REFRESH_SECRET: "x".repeat(32), LEADERBOARD_WARMUP_MODES: "regular,pve",
        LEADERBOARD_WARMUP_MAX_RUN_MS: "1000", LEADERBOARD_WARMUP_MAX_PROFILES: "10",
        LEADERBOARD_WARMUP_MAX_RETRIES: "3", LEADERBOARD_WARMUP_TIMEOUT_MS: "30000",
        PROFILE_QUEUE_DEADLINE_MS: "", LEADERBOARD_WARMUP_BASE_URL: url,
        PVE_PROFILE_UPDATED_URL: `${url}/updated.json`, ...env,
      } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    const timeout = setTimeout(() => child.kill(), 10_000);
    try {
      const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      assert.equal(code, 0, stderr);
      assert.equal(existsSync(lockPath), false, "CLI releases its lock");
      return { result: JSON.parse(stdout.trim()), stderr, elapsed: Date.now() - started };
    } finally { clearTimeout(timeout); }
  } };
}

test("warmup CLI bounds a slow PvE index after processing the preceding mode", async (t) => {
  const events = [];
  const fixture = await warmupCliFixture(t, (request, response) => {
    if (request.url.startsWith("/updated.json")) {
      events.push("feed");
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"2":200,'); // Leave the stream unfinished past the deadline.
    } else {
      events.push("regular");
      response.end('{"state":"ok"}');
    }
  });
  const { result, elapsed } = await fixture.run();
  assert.deepEqual(events, ["regular", "feed"]);
  assert.equal(result.processed, 1);
  assert.equal(result.bounded, true);
  assert.equal(result.stopped, false);
  assert.ok(elapsed < 2000, `CLI exceeded its budget with cleanup/startup allowance: ${elapsed}ms`);
  assert.deepEqual(JSON.parse(readFileSync(fixture.checkpointPath, "utf8")).skipped, {});
});

test("warmup CLI preserves the reset flag and rotates modes across bounded runs", async (t) => {
  const events = [];
  const fixture = await warmupCliFixture(t, (request, response) => {
    if (request.url.startsWith("/updated.json")) response.end('{"2":200}');
    else {
      events.push(request.url.includes("/pve/") ? "pve" : "regular");
      response.end('{"state":"ok"}');
    }
  });
  writeFileSync(fixture.checkpointPath, "");
  for (let run = 0; run < 4; run++) {
    const { result, stderr } = await fixture.run({ LEADERBOARD_WARMUP_MAX_PROFILES: "1" });
    assert.equal(result.processed, 1);
    assert.equal(result.checkpointReset, run === 0);
    assert.equal(stderr.includes("unreadable leaderboard warmup checkpoint"), run === 0);
    assert.equal(result.modes[0], run % 2 === 0 ? "regular" : "pve");
  }
  assert.deepEqual(events, ["regular", "pve", "regular", "pve"]);
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
