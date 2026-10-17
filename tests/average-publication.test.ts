/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- node:sqlite types are newer than the project runtime types.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

const directory = mkdtempSync(join(tmpdir(), "average-publication-"));
const publicationPath = join(directory, "average-publications.db");
process.env.SQLITE_PATH = join(directory, "players.db");
process.env.AVERAGE_PUBLICATION_SQLITE_PATH = publicationPath;
process.env.AVERAGE_PUBLICATIONS_ENABLED = "true";

const publication = await import("../lib/average-publication.ts");
const responseCache = await import("../lib/average-dynamic-cache.ts");

test.after(() => {
  responseCache.resetDynamicAverageCacheForTests();
  publication.resetAveragePublicationForTests();
  try { rmSync(directory, { recursive: true, force: true }); } catch { /* SQLite keeps the adapter open. */ }
});

test("last successful statistics survive a process-cache reset and a failed new scan", async () => {
  responseCache.resetDynamicAverageCacheForTests();
  const identity = JSON.stringify(["cohort", "regular", 44, "all", "median"]);
  const options = { fallbackKey: identity, ttlMs: 100 };
  await responseCache.loadDynamicAverage("old-scan", async () => ({ n: 23, averages: { level: 42 } }), 1000, options);
  responseCache.resetDynamicAverageCacheForTests();
  publication.resetAveragePublicationForTests();
  const restored = await responseCache.loadDynamicAverage("new-scan", async () => { throw new Error("unavailable"); }, 2000, options);
  assert.deepEqual(restored.value, { n: 23, averages: { level: 42 } });
  assert.equal(restored.stale, true);
  assert.equal(restored.generatedAt >= 1000, true);
  await new Promise(setImmediate);
  const persisted = await publication.readStatisticsResponse(`statistics-v1:${identity}`);
  assert.equal(persisted.value.n, 23);
  await assert.rejects(responseCache.loadDynamicAverage("new-scan", async () => { throw new Error("unavailable"); }, 2000,
    { ...options, fallbackKey: JSON.stringify(["cohort", "seasonal", "other-cycle", 44, "all", "median"]) }), /unavailable/);
  responseCache.resetDynamicAverageCacheForTests();
});

test("a cold fallback read succeeds while the publication database has a write lease", async () => {
  const options = { fallbackKey: "writer-lease", ttlMs: 1 };
  await responseCache.loadDynamicAverage("first", async () => ({ n: 25 }), 1000, options);
  responseCache.resetDynamicAverageCacheForTests();
  publication.resetAveragePublicationForTests();
  const writer = new DatabaseSync(publicationPath);
  writer.exec("BEGIN IMMEDIATE");
  try {
    const fallback = await responseCache.loadDynamicAverage("next", async () => { throw new Error("busy"); }, 2000, options);
    assert.equal(fallback.value.n, 25);
    assert.equal(fallback.stale, true);
    await new Promise(setImmediate);
  } finally {
    writer.exec("ROLLBACK"); writer.close();
    responseCache.resetDynamicAverageCacheForTests();
  }
});

test("publication swaps atomically, retains two generations, and survives a failed replacement", async () => {
  const first = await publication.publishAverageScope(
    "regular",
    new Map([[publication.standardAverageVariant("trimmed_mean", "all"), { total: 10 }]]),
    90,
    100,
  );
  assert.equal(first.generation, 100);
  assert.equal((await publication.readAveragePublication("regular", "standard:trimmed_mean:all", 100))?.payload.total, 10);

  const raw = new DatabaseSync(publicationPath);
  raw.exec(`CREATE TRIGGER reject_bad_average BEFORE INSERT ON average_publication_payloads
    WHEN NEW.variant = 'bad' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;`);
  await assert.rejects(
    publication.publishAverageScope("regular", new Map([
      ["standard:trimmed_mean:all", { total: 20 }],
      ["bad", { total: 0 }],
    ]), 190, 200),
    /fixture failure/,
  );
  assert.equal((await publication.readAveragePublication("regular", "standard:trimmed_mean:all", 200))?.payload.total, 10);
  raw.exec("DROP TRIGGER reject_bad_average");

  await publication.publishAverageScope("regular", new Map([["standard:trimmed_mean:all", { total: 30 }]]), 290, 300);
  await publication.markAveragePublicationDirty("regular", 350);
  await publication.publishAverageScope("regular", new Map([["standard:trimmed_mean:all", { total: 40 }]]), 390, 400);
  assert.equal((await publication.readAveragePublication("regular", "standard:trimmed_mean:all", 400))?.payload.total, 40);
  assert.equal(raw.prepare("SELECT COUNT(DISTINCT generation) AS n FROM average_publication_payloads WHERE scope = 'regular'").get().n, 2);
  assert.equal((await publication.getAveragePublicationStates(400)).find((state) => state.scope === "regular")?.dirtyAt, null);
  await publication.markAveragePublicationDirty("regular", 450);
  await publication.publishAverageScope("regular", new Map([["standard:trimmed_mean:all", { total: 50 }]]), 425, 500);
  assert.equal((await publication.getAveragePublicationStates(500)).find((state) => state.scope === "regular")?.dirtyAt, 450);
  raw.close();
});

test("missing and corrupt payloads degrade to null while stale publications remain readable", async () => {
  assert.equal(await publication.readAveragePublication("pve", "missing"), null);
  await publication.publishAverageScope("pve", new Map([["standard:median:all", { total: 1 }]]), 900, 1_000);
  const stale = await publication.readAveragePublication("pve", "standard:median:all", 1_000 + publication.AVERAGE_PUBLICATION_STALE_MS + 1);
  assert.equal(stale?.stale, true);
  publication.resetAveragePublicationForTests();
  const raw = new DatabaseSync(publicationPath);
  raw.prepare("UPDATE average_publication_payloads SET payload_json = 'broken' WHERE scope = 'pve'").run();
  raw.close();
  assert.equal(await publication.readAveragePublication("pve", "standard:median:all"), null);
});

test("publication status distinguishes queued writes from an overdue safety refresh", async () => {
  const generatedAt = 2_000;
  await publication.publishAverageScope("arena", new Map([["standard:teamFight:median", { total: 1 }]]), 1_900, generatedAt);
  const beforeSafetyRefresh = generatedAt + publication.AVERAGE_PUBLICATION_FORCE_INTERVAL_MS - 1;
  assert.equal((await publication.getAveragePublicationStates(beforeSafetyRefresh)).find((state) => state.scope === "arena")?.status, "ready");
  await publication.markAveragePublicationDirty("arena", beforeSafetyRefresh);
  assert.equal((await publication.getAveragePublicationStates(beforeSafetyRefresh)).find((state) => state.scope === "arena")?.status, "dirty");
  await publication.publishAverageScope("arena", new Map([["standard:teamFight:median", { total: 2 }]]), beforeSafetyRefresh, beforeSafetyRefresh + 1);
  const overdueAt = beforeSafetyRefresh + 1 + publication.AVERAGE_PUBLICATION_STALE_MS + 1;
  assert.equal((await publication.getAveragePublicationStates(overdueAt)).find((state) => state.scope === "arena")?.status, "stale");
});

test("dirty scheduling debounces writes and enforces the minimum and forced intervals", () => {
  const now = 10_000_000;
  const ready = {
    scope: "regular", generation: 1, generatedAt: now - 1_000,
    dirtyAt: null, lastStartedAt: now - 2_000, lastCompletedAt: now - 1_000,
    lastDurationMs: 1_000, lastError: null, variants: 4, status: "ready",
  };
  assert.equal(publication.averagePublicationDue(undefined, now), true);
  assert.equal(publication.averagePublicationDue({ ...ready, dirtyAt: now - 60_000 }, now), false);
  assert.equal(publication.averagePublicationDue({
    ...ready,
    dirtyAt: now - publication.AVERAGE_PUBLICATION_DEBOUNCE_MS,
    lastCompletedAt: now - publication.AVERAGE_PUBLICATION_MIN_INTERVAL_MS,
  }, now), true);
  assert.equal(publication.averagePublicationDue({
    ...ready,
    generatedAt: now - publication.AVERAGE_PUBLICATION_FORCE_INTERVAL_MS,
  }, now), true);
});

test("yesterday's publication remains readable in every mode during a failed daily refresh", async () => {
  const now = Date.now();
  const yesterday = now - 26 * 60 * 60_000;
  for (const scope of ["regular", "pve", "arena", "seasonal:stale-fixture"]) {
    const variant = "last-good";
    await publication.publishAverageScope(scope, new Map([[variant, { total: 123 }]]), yesterday, yesterday);
    await publication.beginAveragePublication(scope, now);
    await publication.failAveragePublication(scope, new Error("worker memory limit"));
    const stored = await publication.readAveragePublication(scope, variant, now);
    assert.deepEqual(stored?.payload, { total: 123 });
    assert.equal(stored?.generation, yesterday);
    assert.equal(stored?.stale, true);
  }
});


test("dirty markers yield to HTTP while a writer holds the database and preserve publisher timeout", async () => {
  await publication.markAveragePublicationDirty("regular", 1000);
  const writer = new DatabaseSync(publicationPath);
  writer.exec("BEGIN IMMEDIATE");
  let released = false;
  let heartbeatBeforeRelease = false;
  const started = Date.now();
  const release = setTimeout(() => {
    heartbeatBeforeRelease = Date.now() - started < 1000;
    writer.exec("ROLLBACK");
    released = true;
  }, 20);
  try {
    assert.equal(await publication.markAveragePublicationDirty("regular", 2000), true);
    assert.equal(released, true);
    assert.equal(heartbeatBeforeRelease, true, "a synchronous five-second busy wait must not block the timer");
    const row = writer.prepare("SELECT dirty_at FROM average_publication_state WHERE scope = 'regular'").get();
    assert.equal(row.dirty_at, 2000);
    // Track the actual cached publisher connection rather than this independent writer.
    const originalPrepare = DatabaseSync.prototype.prepare;
    let timeout;
    DatabaseSync.prototype.prepare = function (sql) {
      if (String(sql).startsWith("SELECT s.scope")) timeout = originalPrepare.call(this, "PRAGMA busy_timeout").get().timeout;
      return originalPrepare.call(this, sql);
    };
    try { await publication.getAveragePublicationStates(); }
    finally { DatabaseSync.prototype.prepare = originalPrepare; }
    assert.equal(timeout, 5000);
  } finally {
    clearTimeout(release);
    if (!released) writer.exec("ROLLBACK");
    writer.close();
  }
});
