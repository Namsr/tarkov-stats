import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ARENA_MODE_KEYS, ARENA_RAW_COUNTERS, type ArenaCounters, type ArenaModeKey, type ArenaProfile, type ArenaStoredMode } from "../types/arena.ts";
import {
  decodeStorageJson,
  decodeStorageJsonText,
  encodeStorageJson,
  encodeStorageJsonForWrite,
  STORAGE_JSON_PROJECTION_KEYS,
} from "../lib/storage-json.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href };
    }
    return nextResolve(specifier, context);
  },
});

const { createSqliteProgressionStore } = await import("../lib/progression-db.ts");
const { materializePersistentProgression } = await import("../lib/regular-progression.ts");
const { createSqliteBanStore } = await import("../lib/ban-db.ts");
const { initializeArenaSchema, upsertArenaSqlite } = await import("../lib/arena/storage.ts");

function enableCompression(): () => void {
  const previous = process.env.STORAGE_JSON_COMPRESSION;
  process.env.STORAGE_JSON_COMPRESSION = "true";
  return () => {
    if (previous === undefined) delete process.env.STORAGE_JSON_COMPRESSION;
    else process.env.STORAGE_JSON_COMPRESSION = previous;
  };
}

function asSnapshotStats(value: ReturnType<typeof largeStats>) {
  return value as unknown as import("../lib/ban-db.ts").PlayerSnapshotInput["stats"];
}

function arenaCounters(): ArenaCounters {
  return {
    matches: 20, wins: 10, losses: 5, kills: 40, deaths: 20, assists: 4, headshots: 10, damage: 8000,
    round_mvp: 2, match_mvp: 1, current_kill_streak: 2, max_kill_streak: 5,
    current_win_streak: 1, max_win_streak: 3, current_loss_streak: 0, max_loss_streak: 2,
  };
}

function arenaProfileFixture(): ArenaProfile {
  const metrics = { kd_ratio: 2, win_rate: 50, headshot_rate: 25, kills_per_match: 2, damage_per_match: 400 };
  const modes = Object.fromEntries(ARENA_MODE_KEYS.map((mode: ArenaModeKey) => [mode, {
    mode, hours: 100, counters: arenaCounters(), metrics,
  }])) as Record<ArenaModeKey, ArenaProfile["modes"][ArenaModeKey]>;
  const sourceCounters = Object.fromEntries(["overall", ...ARENA_MODE_KEYS].map((mode) => [mode, {
    Counters: { BestArp: 123, Padding: "repeated-arena-counter".repeat(500) },
  }])) as Partial<Record<ArenaStoredMode, unknown>>;
  return {
    aid: 77_701,
    nickname: "arena-storage-test",
    profileUpdatedAt: 1_750_000_000_000,
    fetchedAt: 1_750_000_000_100,
    parserVersion: 5,
    overall: { hours: 100, counters: arenaCounters(), metrics, bestArp: 123, source: "upstream" },
    modes,
    [ARENA_RAW_COUNTERS]: sourceCounters,
  };
}

function largeStats() {
  return {
    nickname: "projection-test",
    side: "Usec",
    prestige: null,
    level: null,
    experience: 1_000,
    hoursPlayed: 100,
    totalRaids: 46,
    pmcRaids: 44,
    scavRaids: 2,
    pmcSurvived: 12,
    pmcDeaths: 4,
    pmcKills: 23,
    killedPmc: 17,
    survivedRaids: 12,
    deaths: 4,
    totalKills: 23,
    runThrough: null,
    longestWinStreak: null,
    achievementsCount: null,
    profileUpdatedAt: 1_750_000_000_000,
    pmcKilledPmc: 17,
    pmcKdRatio: null,
    pvpStatsKnown: false,
    pvpStatsVersion: 1,
    pvpStatsParserVersion: 4,
    lastPlayedAt: 1_750_000_000_000,
    raidsOrMatches: 44,
    leaderboardActivityAt: null,
    unknownHistory: { values: Array.from({ length: 100 }, (_, i) => ({ i, text: "repeated-history-value" })) },
  };
}

test("storage JSON preserves the exact source and unknown fields", () => {
  const source = JSON.stringify(largeStats());
  const encoded = encodeStorageJson(source);
  assert.notEqual(encoded, source);
  assert.equal(decodeStorageJsonText(encoded), source);
  assert.deepEqual(decodeStorageJson(encoded), JSON.parse(source));
  assert.equal(decodeStorageJsonText(source), source);
});

test("compressed projections retain SQLite JSON1 missing/null/bool semantics", () => {
  const source = JSON.stringify(largeStats());
  const encoded = encodeStorageJson(source);
  const db = new DatabaseSync(":memory:");
  try {
    const select = STORAGE_JSON_PROJECTION_KEYS.map((key, i) => [
      `json_type(?, '$.${key}') AS type_${i}`,
      `json_extract(?, '$.${key}') AS value_${i}`,
      `? -> '$.${key}' AS arrow_${i}`,
    ]).flat();
    const query = db.prepare(`SELECT
      json_valid(?) AS valid,
      json_type(?, '$.missingKey') AS missing_type,
      json_extract(?, '$.missingKey') AS missing_value,
      ${select.join(",\n      ")}`);
    const params = (json: string) => [json, json, json,
      ...STORAGE_JSON_PROJECTION_KEYS.flatMap(() => [json, json, json])];
    const legacy = query.get(...params(source));
    const projected = query.get(...params(encoded));
    assert.deepEqual(projected, legacy);
  } finally {
    db.close();
  }
});

test("reserved collisions and duplicate-key legacy JSON stay plaintext", () => {
  const collision = JSON.stringify({
    __tarkovstats_storage: { legacy: true },
    unknownHistory: "x".repeat(800),
  });
  assert.equal(encodeStorageJson(collision), collision);
  assert.equal(decodeStorageJsonText(collision), collision);

  const duplicate = '{"pmcKdRatio":null,"pmcKdRatio":7,"unknownHistory":"' + "x".repeat(800) + '"}';
  assert.equal(encodeStorageJson(duplicate), duplicate);
  assert.equal(decodeStorageJsonText(duplicate), duplicate);
});

test("corrupt marked payloads fail closed", () => {
  const encoded = encodeStorageJson(JSON.stringify(largeStats()));
  const envelope = JSON.parse(encoded) as {
    __tarkovstats_storage: { magic: string; version: number; codec: string; sha256: string; data: string };
    pmcKilledPmc: number;
  };
  const clone = () => JSON.parse(JSON.stringify(envelope));

  const checksum = clone();
  checksum.__tarkovstats_storage.sha256 = "0".repeat(64);
  assert.throws(() => decodeStorageJsonText(JSON.stringify(checksum)), /invalid stored JSON envelope/);

  const base64 = clone();
  base64.__tarkovstats_storage.data = "!!!!";
  assert.throws(() => decodeStorageJsonText(JSON.stringify(base64)), /invalid stored JSON envelope/);

  const gzip = clone();
  gzip.__tarkovstats_storage.data = Buffer.from("not gzip").toString("base64");
  assert.throws(() => decodeStorageJsonText(JSON.stringify(gzip)), /invalid stored JSON envelope/);

  const projection = clone();
  projection.pmcKilledPmc = 999;
  assert.throws(() => decodeStorageJsonText(JSON.stringify(projection)), /projection mismatch/);

  const version = clone();
  version.__tarkovstats_storage.version = 99;
  assert.throws(() => decodeStorageJsonText(JSON.stringify(version)), /unsupported version/);

  const oversizedRaw = JSON.stringify({ oversized: "x".repeat(9 * 1024 * 1024) });
  const oversized = {
    __tarkovstats_storage: {
      magic: "tarkovstats-json", version: 1, codec: "gzip-base64",
      sha256: createHash("sha256").update(oversizedRaw).digest("hex"),
      data: gzipSync(Buffer.from(oversizedRaw)).toString("base64"),
    },
  };
  assert.throws(() => decodeStorageJsonText(JSON.stringify(oversized)), /invalid stored JSON envelope/);
});

test("small and incompressible payloads never grow", () => {
  const small = JSON.stringify({ nickname: "short" });
  assert.equal(encodeStorageJson(small), small);

  const incompressible = JSON.stringify({ payload: randomBytes(8 * 1024).toString("base64") });
  const encoded = encodeStorageJson(incompressible);
  assert.ok(Buffer.byteLength(encoded) <= Buffer.byteLength(incompressible));
  assert.equal(decodeStorageJsonText(encoded), incompressible);
});

test("runtime writes stay plaintext until compression is explicitly enabled", () => {
  const source = JSON.stringify(largeStats());
  const previous = process.env.STORAGE_JSON_COMPRESSION;
  delete process.env.STORAGE_JSON_COMPRESSION;
  try {
    assert.equal(encodeStorageJsonForWrite(source), source);
    process.env.STORAGE_JSON_COMPRESSION = "true";
    assert.equal(encodeStorageJsonForWrite(source), encodeStorageJson(source));
  } finally {
    if (previous === undefined) delete process.env.STORAGE_JSON_COMPRESSION;
    else process.env.STORAGE_JSON_COMPRESSION = previous;
  }
});

test("Arena current and history writers opt into the same reversible envelope", () => {
  const restoreCompression = enableCompression();
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE excluded_players (aid INTEGER PRIMARY KEY)");
    initializeArenaSchema(db);
    upsertArenaSqlite(db, arenaProfileFixture(), 1_750_000_000_200);
    const current = db.prepare("SELECT arena_mode, raw_json FROM arena_mode_stats WHERE aid = ?").all(77_701) as { arena_mode: string; raw_json: string }[];
    const history = db.prepare("SELECT arena_mode, raw_json FROM arena_mode_stats_history WHERE aid = ?").all(77_701) as { arena_mode: string; raw_json: string }[];
    assert.equal(current.length, 6);
    assert.equal(history.length, 6);
    for (const rows of [current, history]) {
      for (const row of rows) {
        const decoded = decodeStorageJson<{ normalized?: { mode?: string }; sourceCounters?: unknown }>(row.raw_json);
        assert.equal(decoded.normalized?.mode, row.arena_mode);
        assert.ok(decoded.sourceCounters);
      }
    }
  } finally {
    db.close();
    restoreCompression();
  }
});

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(?:ts|tsx|js|mjs)$/.test(entry.name)) files.push(path);
  }
  return files;
}

test("every SQL stats_json path is present in the shared projection registry", () => {
  const paths = new Map<string, string[]>();
  const patterns = [
    /json_(?:extract|type)\(\s*[^)]*?\bstats_json\b[^)]*?,\s*["']\$\.([A-Za-z0-9_]+)["']/gi,
    /\bstats_json\s*->\s*["']\$\.([A-Za-z0-9_]+)["']/gi,
  ];
  for (const directory of [resolve("lib"), resolve("scripts")]) {
    for (const file of sourceFiles(directory)) {
      const source = readFileSync(file, "utf8");
      const found: string[] = [];
      for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) found.push(match[1]);
      }
      if (found.length) paths.set(file, [...new Set(found)]);
    }
  }
  const registry = new Set<string>(STORAGE_JSON_PROJECTION_KEYS);
  const missing = [...paths].flatMap(([file, keys]) => keys.filter((key) => !registry.has(key)).map((key) => `${file}: ${key}`));
  assert.ok(paths.size > 0, "the guard must inspect at least one stats_json SQL reader");
  assert.deepEqual(missing, []);
});

test("the progression store and materializer decode a compressed snapshot", async () => {
  const restoreCompression = enableCompression();
  const db = new DatabaseSync(":memory:");
  try {
    const store = createSqliteProgressionStore(db);
    const stats = largeStats();
    const input = { aid: 9_991, upstreamUpdatedAt: stats.profileUpdatedAt, capturedAt: stats.profileUpdatedAt + 1,
      stats, achievementIds: [] };
    assert.equal((await store.recordSnapshot({ ...input, stats: asSnapshotStats(stats) })).inserted, true);
    const raw = (db.prepare("SELECT stats_json FROM progression_snapshots WHERE aid = ?").get(input.aid) as { stats_json: string }).stats_json;
    assert.notEqual(raw, JSON.stringify(stats));
    const latest = await store.latest(input.aid);
    assert.ok(latest);
    assert.deepEqual(latest.stats, stats);
    materializePersistentProgression(db, "regular", input.aid, { refreshAggregates: false });
    assert.equal((db.prepare("SELECT experience FROM player_profiles WHERE aid = ?").get(input.aid) as { experience: number }).experience, stats.experience);
  } finally {
    db.close();
    restoreCompression();
  }
});

test("banned snapshot archive preserves and decodes compressed progression history", async () => {
  const restoreCompression = enableCompression();
  const directory = mkdtempSync(join(tmpdir(), "storage-json-ban-"));
  const paths = {
    bans: join(directory, "bans.db"), players: join(directory, "players.db"), progression: join(directory, "progression.db"),
  };
  const previous = Object.fromEntries(Object.keys({ BANS_SQLITE_PATH: "", SQLITE_PATH: "", PROGRESSION_SQLITE_PATH: "" })
    .map((key) => [key, process.env[key]]));
  const restoreEnv = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    process.env.BANS_SQLITE_PATH = paths.bans;
    process.env.SQLITE_PATH = paths.players;
    process.env.PROGRESSION_SQLITE_PATH = paths.progression;
    new DatabaseSync(paths.players).close();
    const progression = new DatabaseSync(paths.progression);
    const stats = largeStats();
    await createSqliteProgressionStore(progression).recordSnapshot({
      aid: 8_882, upstreamUpdatedAt: stats.profileUpdatedAt, capturedAt: stats.profileUpdatedAt + 1,
      stats: asSnapshotStats(stats), achievementIds: [],
    });
    const source = (progression.prepare("SELECT stats_json FROM progression_snapshots WHERE aid = ?").get(8_882) as { stats_json: string }).stats_json;
    progression.close();

    const bans = new DatabaseSync(paths.bans);
    try {
      await createSqliteBanStore(bans).confirmBanned({
        aid: 8_882, upstreamUpdatedAt: stats.profileUpdatedAt, capturedAt: stats.profileUpdatedAt + 2,
        stats: asSnapshotStats(stats), achievementIds: [],
      });
      const archived = (bans.prepare("SELECT stats_json FROM banned_snapshots WHERE aid = ?").get(8_882) as { stats_json: string }).stats_json;
      assert.equal(archived, JSON.stringify(stats));
      assert.notEqual(archived, source);
      assert.deepEqual(decodeStorageJson(archived), stats);
    } finally {
      bans.close();
    }
  } finally {
    restoreEnv();
    restoreCompression();
    rmSync(directory, { recursive: true, force: true });
  }
});
