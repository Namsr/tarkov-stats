/**
 * Deterministic, disposable Arena computation benchmark (no network or live DB).
 * node --experimental-strip-types --expose-gc scripts/benchmark-arena-compute.mjs
 * ARENA_BENCH_N=25000 ARENA_BENCH_RUNS=7 override the fixture size/repetitions.
 * Measures uncached service calls; API/cache/network latency is not included.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const root = fileURLToPath(new URL("../", import.meta.url));
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: pathToFileURL(resolve(root, `${specifier.slice(2)}.ts`)).href };
    }
    return nextResolve(specifier, context);
  },
});
const count = Number(process.env.ARENA_BENCH_N ?? 25_000);
const runs = Number(process.env.ARENA_BENCH_RUNS ?? 7);
assert.ok(Number.isSafeInteger(count) && count >= 100 && count <= 100_000);
assert.ok(Number.isSafeInteger(runs) && runs >= 1 && runs <= 50);
const directory = mkdtempSync(join(tmpdir(), "arena-compute-bench-"));
process.env.SQLITE_PATH = join(directory, "players.db");
process.env.BANS_SQLITE_PATH = join(directory, "bans.db");
const { getArenaBackend } = await import("../lib/db.ts");
const { getArenaCohort, getArenaProfileRisk } = await import("../lib/arena/service.ts");
const { ARENA_PARSER_VERSION } = await import("../lib/arena/storage.ts");
const backend = await getArenaBackend();
assert.equal(backend?.kind, "sqlite");
const db = backend.db;
try {
  const modes = ["overall", "teamFight", "lastHero", "checkpoint", "blastGang", "shootOutDuo"];
  const insert = db.prepare(`INSERT INTO arena_mode_stats
    (aid, arena_mode, hours, games_count, kd_ratio, win_rate, headshot_rate,
     kills_per_match, damage_per_match, upstream_version, parser_version, raw_json, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const raw = JSON.stringify({ padding: "x".repeat(1024) });
  db.exec("BEGIN");
  for (let aid = 1; aid <= count; aid++) {
    for (let mode = 0; mode < modes.length; mode++) {
      const h = aid === 1 ? 100 : 70 + ((aid * 17 + mode * 13) % 601) / 10;
      const games = aid === 1 ? 100 : 70 + ((aid * 7 + mode * 3) % 61);
      insert.run(aid, modes[mode], h, games,
        aid % 37 ? ((aid * 3) % 100) / 20 : null,
        20 + ((aid * 11) % 80), aid % 41 ? (aid % 70) : null,
        2 + ((aid * 13) % 100) / 10, 100 + ((aid * 19) % 2500),
        1_800_000_000_000 + aid, aid % 101 ? ARENA_PARSER_VERSION : 0, raw, 1_800_000_000_000);
    }
  }
  db.exec("COMMIT; ANALYZE");

  let rowsReturned = 0;
  const prepare = db.prepare;
  db.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    const all = statement.all;
    statement.all = function (...args) {
      const result = all.apply(this, args);
      rowsReturned += result.length;
      return result;
    };
    const iterate = statement.iterate;
    statement.iterate = function* (...args) {
      for (const row of iterate.apply(this, args)) {
        rowsReturned++;
        yield row;
      }
    };
    return statement;
  };
  const cases = [
    ["cohort_matched_trimmed", () => getArenaCohort(1, "teamFight", "trimmed_mean")],
    ["cohort_matched_median", () => getArenaCohort(1, "teamFight", "median")],
    ["cohort_overall_trimmed", () => getArenaCohort(1, "overall", "trimmed_mean")],
    ["cohort_overall_median", () => getArenaCohort(1, "overall", "median")],
    ["risk_recompute", () => getArenaProfileRisk(1)],
  ];
  const results = [];
  for (const [name, run] of cases) {
    const samples = [];
    await run(); // Warm SQLite pages/JIT; every measured call still recomputes.
    for (let i = 0; i < runs; i++) {
      global.gc?.();
      rowsReturned = 0;
      const heap = process.memoryUsage().heapUsed;
      const cpu = process.cpuUsage();
      const started = performance.now();
      const result = await run();
      const ms = performance.now() - started;
      const used = process.cpuUsage(cpu);
      assert.ok(result);
      samples.push({ ms, cpuMs: (used.user + used.system) / 1000,
        heapGrowthMiB: Math.max(0, process.memoryUsage().heapUsed - heap) / 1024 ** 2, rowsReturned });
    }
    const percentile = (key, p) => {
      const sorted = samples.map((sample) => sample[key]).sort((a, b) => a - b);
      return Math.round(sorted[Math.ceil(sorted.length * p) - 1] * 100) / 100;
    };
    results.push({ name, runs, p50Ms: percentile("ms", 0.5), p95Ms: percentile("ms", 0.95),
      cpuP50Ms: percentile("cpuMs", 0.5), maxHeapGrowthMiB: percentile("heapGrowthMiB", 1),
      rowsReturned: percentile("rowsReturned", 0.5) });
  }
  const update = db.prepare(`UPDATE arena_mode_stats SET games_count = games_count + 1,
    kd_ratio = COALESCE(kd_ratio, 0) + 0.01, upstream_version = upstream_version + 1 WHERE aid = ?`);
  const writeStarted = performance.now();
  db.exec("BEGIN");
  const updatedPlayers = Math.min(count, 1000);
  for (let aid = 1; aid <= updatedPlayers; aid++) update.run(aid);
  db.exec("COMMIT");
  const writeBatch = { players: updatedPlayers, rows: updatedPlayers * modes.length,
    ms: Math.round((performance.now() - writeStarted) * 100) / 100 };
  console.log(JSON.stringify({ node: process.version, players: count, storedRows: count * modes.length,
    gcEnabled: Boolean(global.gc), maxRssMiB: process.resourceUsage().maxRSS / 1024, results, writeBatch }, null, 2));
} finally {
  db.close();
  // Only remove the generated child of the OS temp directory.
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith("arena-compute-bench-"));
  rmSync(directory, { recursive: true, force: true });
}
