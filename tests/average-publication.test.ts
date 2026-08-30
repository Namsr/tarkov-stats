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
const { standardAveragePublicationVariants } = await import("../lib/average-publication-variants.ts");
const dynamicCache = await import("../lib/average-dynamic-cache.ts");

test.after(() => {
  publication.resetAveragePublicationForTests();
  rmSync(directory, { recursive: true, force: true });
});

test("standard publication matrix contains the 22 promised variants", () => {
  const variants = standardAveragePublicationVariants("cycle-1");
  assert.equal(variants.length, 22);
  assert.deepEqual(
    Object.fromEntries(["regular", "pve", "seasonal:cycle-1", "arena"].map((scope) => [
      scope,
      variants.filter((variant) => variant.scope === scope).length,
    ])),
    { regular: 4, pve: 4, "seasonal:cycle-1": 4, arena: 10 },
  );
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

test("dynamic average cache deduplicates in-flight work and expires after five minutes", async () => {
  dynamicCache.resetDynamicAverageCacheForTests();
  let calls = 0;
  const load = async () => ++calls;
  const [first, second] = await Promise.all([
    dynamicCache.loadDynamicAverage("same", load, 1_000),
    dynamicCache.loadDynamicAverage("same", load, 1_000),
  ]);
  assert.equal(first.value, 1);
  assert.equal(second.value, 1);
  assert.equal(second.cache, "hit");
  assert.equal((await dynamicCache.loadDynamicAverage("same", load, 1_000 + 5 * 60_000 + 1)).value, 2);
});
