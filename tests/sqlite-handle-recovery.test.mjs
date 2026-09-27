import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
    }
    // The seasonal openers import their siblings without an extension, which the
    // bundler resolves but the ESM resolver does not.
    if (/^\.{1,2}\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      return { shortCircuit: true, url: new URL(`${specifier}.ts`, context.parentURL).href };
    }
    return nextResolve(specifier, context);
  },
});

const directory = mkdtempSync(join(tmpdir(), "sqlite-handle-recovery-"));
const playersPath = join(directory, "players.db");
const progressionPath = join(directory, "progression.db");

const previousSqlitePath = process.env.SQLITE_PATH;
const previousProgressionPath = process.env.PROGRESSION_SQLITE_PATH;
process.env.SQLITE_PATH = playersPath;
process.env.PROGRESSION_SQLITE_PATH = progressionPath;

const { getArenaBackend } = await import("../lib/db.ts");
const { getSeasonalStore } = await import("../lib/seasonal/storage.ts");

test.after(() => {
  if (previousSqlitePath === undefined) delete process.env.SQLITE_PATH;
  else process.env.SQLITE_PATH = previousSqlitePath;
  if (previousProgressionPath === undefined) delete process.env.PROGRESSION_SQLITE_PATH;
  else process.env.PROGRESSION_SQLITE_PATH = previousProgressionPath;
  // The directories are left behind: the openers cache their handle for the life
  // of the process, and Windows refuses to delete an open database file.
});

// A file that is not a SQLite database: the constructor opens it lazily, so the
// handle is created and the failure lands in the schema initialization instead.
function poison(path) {
  writeFileSync(path, "this is not a sqlite database");
}

test("the player database opener retries initialization instead of serving a poisoned handle", async () => {
  poison(playersPath);
  assert.equal(await getArenaBackend(), null, "a failed schema init reports unavailable");

  rmSync(playersPath, { force: true });
  const backend = await getArenaBackend();
  assert.ok(backend, "the next call reopens and initializes the database");
  const tables = backend.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
  assert.ok(tables.includes("arena_mode_stats"), "the arena schema was applied on the retry");
  assert.ok(tables.includes("players"), "the player schema was applied on the retry");
});

test("the seasonal store opener retries initialization instead of serving a poisoned handle", async () => {
  poison(progressionPath);
  assert.equal(await getSeasonalStore(), null, "a failed schema init reports unavailable");

  rmSync(progressionPath, { force: true });
  const store = await getSeasonalStore();
  assert.ok(store, "the next call reopens and initializes the database");
  assert.deepEqual(await store.getCycle("cycle-missing"), null, "the seasonal schema is queryable");
});
