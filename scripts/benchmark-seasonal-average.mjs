/**
 * Benchmark for issue #20: seasonal average publication on production-size data.
 *
 * Usage:
 *   node --experimental-strip-types scripts/benchmark-seasonal-average.mjs
 *   SEASONAL_BENCH_N=20000 node --experimental-strip-types scripts/benchmark-seasonal-average.mjs
 *   SEASONAL_BENCH_DB=/copy/of/progression.db node --experimental-strip-types scripts/benchmark-seasonal-average.mjs
 *
 * When SEASONAL_BENCH_DB points at a production copy, the script benchmarks the
 * shared-portrait batch path on that copy without writing to it. Otherwise it
 * seeds a synthetic database with SEASONAL_BENCH_N players (default 20000) and
 * measures the full four-variant publication build. The 60s budget from the
 * issue is asserted at the end.
 */
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const BUDGET_MS = 60_000;

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

async function seedSynthetic(databasePath, count, cycleId, now) {
  const { initializeSeasonalSchema } = await import("../lib/seasonal/storage.ts");
  const db = new DatabaseSync(databasePath);
  initializeSeasonalSchema(db);
  const random = mulberry32(0xC10C);
  db.prepare(
    "INSERT OR REPLACE INTO season_cycles (mode, cycle_id, starts_at, enabled) VALUES ('seasonal', ?, ?, 1)",
  ).run(cycleId, now - 200 * 86_400_000);
  const profile = db.prepare(`INSERT INTO player_profiles (
    mode, cycle_id, aid, nickname, profile_updated_at, last_access_at, lifetime_pvp_hours,
    experience, pmc_raids, scav_raids, pmc_survived, pmc_deaths, pmc_kills, killed_pmc,
    first_seen_at, last_seen_at, confirmed_banned
  ) VALUES ('seasonal', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const snapshot = db.prepare(`INSERT INTO progression_snapshots (
    mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at, local_date,
    experience, total_raids, pmc_raids, scav_raids, survived, pmc_survived, deaths,
    pmc_deaths, pmc_kills, total_kills, killed_pmc, run_through, level, prestige,
    longest_win_streak, achv_count, achievements
  ) VALUES ('seasonal', ?, ?, ?, ?, ?, '2026-01-01', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let aid = 1; aid <= count; aid += 1) {
      const ageDays = Math.floor(random() * 120);
      const updated = now - ageDays * 86_400_000 - Math.floor(random() * 86_400_000);
      const hours = Math.floor(random() * 6000 * 10) / 10;
      const pmcRaids = 1 + Math.floor(random() * 400);
      const scavRaids = Math.floor(random() * 80);
      const totalRaids = pmcRaids + scavRaids;
      const survived = Math.floor(random() * (totalRaids + 1));
      const deaths = Math.max(0, totalRaids - survived);
      const totalKills = Math.floor(random() * totalRaids * 2);
      const killedPmc = Math.floor(random() * Math.min(totalKills, pmcRaids));
      const banned = random() < 0.01 ? 1 : 0;
      profile.run(
        cycleId, aid, `bench-${aid}`, updated, updated, hours,
        1000 + aid, pmcRaids, scavRaids, Math.floor(pmcRaids / 2), Math.floor(pmcRaids / 4),
        Math.floor(pmcRaids / 2), Math.floor(pmcRaids / 8), updated, updated, banned,
      );
      snapshot.run(
        cycleId, aid, updated, updated, updated, 1000 + aid, totalRaids, pmcRaids, scavRaids,
        survived, Math.floor(pmcRaids / 2), deaths, Math.floor(pmcRaids / 4),
        Math.floor(pmcRaids / 2), totalKills, killedPmc, 0, null, null, null, null, "[]",
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  db.close();
}

const existingDb = process.env.SEASONAL_BENCH_DB?.trim();
const count = Number(process.env.SEASONAL_BENCH_N ?? 20_000);
const cycleId = process.env.SEASONAL_BENCH_CYCLE?.trim() || "bench-cycle";
const now = Date.now();

let databasePath = existingDb || null;
let temporaryDirectory = null;
if (!databasePath) {
  if (!Number.isSafeInteger(count) || count <= 0 || count > 500_000) {
    console.error(`invalid SEASONAL_BENCH_N: ${process.env.SEASONAL_BENCH_N}`);
    process.exitCode = 1;
    process.exit(1);
  }
  temporaryDirectory = mkdtempSync(join(tmpdir(), "seasonal-average-bench-"));
  databasePath = join(temporaryDirectory, "progression.db");
  console.log(`seeding synthetic seasonal dataset`, { rows: count, cycleId });
  const seedStartedAt = Date.now();
  await seedSynthetic(databasePath, count, cycleId, now);
  console.log(`synthetic dataset ready`, { seedMs: Date.now() - seedStartedAt });
} else if (!existsSync(databasePath)) {
  console.error(`SEASONAL_BENCH_DB does not exist: ${databasePath}`);
  process.exitCode = 1;
  process.exit(1);
} else {
  console.log(`benchmarking production copy`, { databasePath, cycleId });
}

const previousPath = process.env.PROGRESSION_SQLITE_PATH;
process.env.PROGRESSION_SQLITE_PATH = databasePath;
try {
  const { getSeasonalAveragePublicationPayloads } = await import("../lib/seasonal/average-db.ts");
  const startedAt = Date.now();
  const batch = await getSeasonalAveragePublicationPayloads(cycleId, now);
  const totalMs = Date.now() - startedAt;
  if (!batch) {
    console.error("seasonal average storage unavailable");
    process.exitCode = 1;
    process.exit(1);
  }
  const summary = {
    cycleId,
    portraitRows: batch.timings.portraitRows,
    portraitFetchMs: batch.timings.portraitFetchMs,
    variants: batch.timings.variants,
    totalMs: batch.timings.totalMs,
    wallTotalMs: totalMs,
    budgetMs: BUDGET_MS,
    withinBudget: totalMs <= BUDGET_MS,
    variantCount: batch.payloads.size,
  };
  console.log("seasonal average benchmark", summary);
  if (!summary.withinBudget || batch.payloads.size !== 4) {
    console.error(`benchmark FAILED: ${totalMs}ms exceeds ${BUDGET_MS}ms or incomplete variants`);
    process.exitCode = 1;
  }
} finally {
  if (previousPath === undefined) delete process.env.PROGRESSION_SQLITE_PATH;
  else process.env.PROGRESSION_SQLITE_PATH = previousPath;
  if (temporaryDirectory) {
    try { rmSync(temporaryDirectory, { recursive: true, force: true }); } catch { /* keep temp for debugging */ }
  }
}
