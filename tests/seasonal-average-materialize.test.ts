/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- node:sqlite types are not present in the project's Node 20 type package.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { initializeSeasonalSchema } from "../lib/seasonal/storage.ts";

const directory = mkdtempSync(join(tmpdir(), "seasonal-average-materialize-"));
const databasePath = join(directory, "progression.db");
const publicationDirectory = mkdtempSync(join(tmpdir(), "seasonal-average-publish-"));
const previousProgressionPath = process.env.PROGRESSION_SQLITE_PATH;
const previousSqlitePath = process.env.SQLITE_PATH;
const previousPublicationPath = process.env.AVERAGE_PUBLICATION_SQLITE_PATH;
const previousPublicationsEnabled = process.env.AVERAGE_PUBLICATIONS_ENABLED;
process.env.PROGRESSION_SQLITE_PATH = databasePath;
process.env.SQLITE_PATH = join(publicationDirectory, "players.db");
process.env.AVERAGE_PUBLICATION_SQLITE_PATH = join(publicationDirectory, "average-publications.db");
process.env.AVERAGE_PUBLICATIONS_ENABLED = "true";

const now = 1_800_000_000_000;

function seed() {
  const db = new DatabaseSync(databasePath);
  initializeSeasonalSchema(db);
  db.prepare("INSERT INTO season_cycles (mode, cycle_id, starts_at, enabled) VALUES ('seasonal', ?, ?, 1)")
    .run("s1", now - 200 * 86_400_000);
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
  const add = (aid, updated, hours, raids, kills, banned = 0) => {
    profile.run("s1", aid, `p-${aid}`, updated, updated, hours, 100, raids, 0, raids, 1, kills, 0, updated, updated, banned);
    snapshot.run("s1", aid, updated, updated, updated, 100, raids, raids, 0, 1, raids, 1, 1, kills, kills, 0, null, null, null, null, null, "[]");
  };
  add(1, now - 1_000, 10, 10, 4);
  add(2, now - 10 * 86_400_000, 120, 20, 8);
  add(3, now - 100 * 86_400_000, 2500, 60, 30);
  add(4, now - 1_000, 40, 40, 16, 1);
  db.close();
}

seed();

const averageDb = await import("../lib/seasonal/average-db.ts");

test.after(() => {
  if (previousProgressionPath === undefined) delete process.env.PROGRESSION_SQLITE_PATH;
  else process.env.PROGRESSION_SQLITE_PATH = previousProgressionPath;
  if (previousSqlitePath === undefined) delete process.env.SQLITE_PATH;
  else process.env.SQLITE_PATH = previousSqlitePath;
  if (previousPublicationPath === undefined) delete process.env.AVERAGE_PUBLICATION_SQLITE_PATH;
  else process.env.AVERAGE_PUBLICATION_SQLITE_PATH = previousPublicationPath;
  if (previousPublicationsEnabled === undefined) delete process.env.AVERAGE_PUBLICATIONS_ENABLED;
  else process.env.AVERAGE_PUBLICATIONS_ENABLED = previousPublicationsEnabled;
  try { rmSync(directory, { recursive: true, force: true }); } catch { /* SQLite keeps the adapter open. */ }
  try { rmSync(publicationDirectory, { recursive: true, force: true }); } catch { /* SQLite keeps the adapter open. */ }
});

test("delayed portrait fetch builds all seasonal variants from a single slow query", async () => {
  const batch = await averageDb.getSeasonalAveragePublicationPayloads("s1", now);
  assert.ok(batch);
  assert.equal(batch.payloads.size, 4);
  const rows = batch.timings.portraitRows;
  assert.ok(rows > 0);

  // Simulate the dominant production phase: one slow portrait scan shared by
  // all variants instead of four sequential slow cross-section queries.
  let fetches = 0;
  const slowFetchPortrait = async () => {
    fetches += 1;
    await new Promise((resolve) => setTimeout(resolve, 60));
    return [
      { profile_updated_at: now - 1_000, hours: 10, pmc_raids: 10, total_kills: 4 },
      { profile_updated_at: now - 1_000, hours: 20, pmc_raids: 20, total_kills: 8 },
    ];
  };
  const startedAt = Date.now();
  const shared = await slowFetchPortrait();
  const variants = [];
  for (const statistic of ["trimmed_mean", "median"]) {
    for (const period of ["all", "90d"]) {
      variants.push(averageDb.buildSeasonalCrossSectionFromRows(shared, {
        cycleId: "s1", period, statistic, dimension: "hours", metric: "players", min: null, max: null, now,
      }));
    }
  }
  const elapsed = Date.now() - startedAt;

  assert.equal(fetches, 1);
  assert.equal(variants.length, 4);
  for (const variant of variants) assert.equal(variant.total, 2);
  // Four sequential 60ms fetches would take ~240ms; sharing stays near one delay.
  assert.ok(elapsed < 150, `shared portrait fetch must avoid 4x slow queries, took ${elapsed}ms`);
});

test("slow variant computation still publishes atomically without partial generations", async () => {
  const publication = await import("../lib/average-publication.ts");
  const scope = "seasonal:s1";
  // Nothing is visible while the four delayed variants are still computing.
  assert.equal(await publication.readAveragePublication(scope, "standard:trimmed_mean:all", now), null);

  const batch = await averageDb.getSeasonalAveragePublicationPayloads("s1", now);
  assert.ok(batch);
  const delayed = new Map();
  for (const [variant, payload] of batch.payloads) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    delayed.set(variant, payload);
  }
  assert.equal(delayed.size, 4);
  // Still nothing published until the complete set is swapped in one transaction.
  assert.equal(await publication.readAveragePublication(scope, "standard:trimmed_mean:all", now), null);

  const startedAt = now - 5_000;
  const result = await publication.publishAverageScope(scope, delayed, startedAt, now);
  assert.equal(result.variants, 4);
  for (const variant of delayed.keys()) {
    const stored = await publication.readAveragePublication(scope, variant, now);
    assert.ok(stored, `variant ${variant} must be readable after atomic publish`);
    assert.equal(stored.generation, result.generation);
  }

  // A failed replacement must keep the previous complete generation readable.
  const raw = new DatabaseSync(join(publicationDirectory, "average-publications.db"));
  raw.exec(`CREATE TRIGGER reject_seasonal_average BEFORE INSERT ON average_publication_payloads
    WHEN NEW.variant = 'bad' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;`);
  await assert.rejects(
    publication.publishAverageScope(scope, new Map([
      ["standard:trimmed_mean:all", { total: 1 }],
      ["bad", { total: 0 }],
    ]), now, now + 1),
    /fixture failure/,
  );
  raw.exec("DROP TRIGGER reject_seasonal_average");
  raw.close();
  assert.equal(
    (await publication.readAveragePublication(scope, "standard:trimmed_mean:all", now + 1))?.generation,
    result.generation,
  );
});

test("batch matches per-variant queries and exposes per-variant plus SQL-phase timings", async () => {
  const query = await averageDb.getSeasonalAverageCrossSectionQuery();
  assert.ok(query);
  const batch = await averageDb.getSeasonalAveragePublicationPayloads("s1", now);
  assert.ok(batch);
  assert.equal(batch.payloads.size, 4);
  assert.ok(batch.timings.portraitFetchMs >= 0);
  assert.ok(batch.timings.totalMs >= 0);
  assert.equal(batch.timings.variants.length, 4);

  for (const timing of batch.timings.variants) {
    assert.match(timing.variant, /^standard:(trimmed_mean|median):(all|90d)$/);
    assert.ok(timing.computeMs >= 0);
    const expected = await query({
      cycleId: "s1", period: timing.period, statistic: timing.statistic,
      dimension: "hours", metric: "players", min: null, max: null, now,
    });
    assert.ok(expected);
    assert.deepEqual(batch.payloads.get(timing.variant), expected);
  }
});

test("seasonal materializer uses the shared batch with timings and a single atomic publish", async () => {
  const materializer = await readFile("scripts/materialize-average-publications.mjs", "utf8");
  const database = await readFile("lib/seasonal/average-db.ts", "utf8");

  // Single shared portrait scan replaces the per-variant cross-section loop.
  assert.match(materializer, /getSeasonalAveragePublicationPayloads/);
  assert.doesNotMatch(materializer, /getSeasonalAverageCrossSectionQuery/);
  assert.match(materializer, /seasonal average variants completed/);
  assert.match(materializer, /portraitFetchMs/);
  assert.match(materializer, /sqlPhases/);
  assert.match(materializer, /variants:\s*timings\.variants/);

  // The complete variant set is still swapped atomically; no partial publish.
  assert.match(materializer, /publishAverageScope\(scope, payloads, startedAt\)/);
  const publishCount = (materializer.match(/publishAverageScope\(/g) ?? []).length;
  assert.equal(publishCount, 1);

  // Batch implementation keeps one portrait query plus in-JS aggregation.
  assert.match(database, /getSeasonalAveragePublicationPayloads/);
  assert.match(database, /SELECT \$\{SEASONAL_PORTRAIT_COLUMNS\.join/);
  assert.match(database, /buildSeasonalCrossSectionFromRows/);
  assert.match(database, /portraitFetchMs/);
  assert.match(database, /152 scans|~38 times per variant/);
});
