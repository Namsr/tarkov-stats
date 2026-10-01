/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript runner requires explicit .ts imports.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import test from "node:test";
// @ts-ignore -- Node 24 exposes node:sqlite at runtime; project types target Node 20.
import { DatabaseSync } from "node:sqlite";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
    }
    return nextResolve(specifier, context);
  },
});

const directory = mkdtempSync(join(tmpdir(), "tarkov-index-coverage-"));
const playersPath = join(directory, "players.db");
process.env.SQLITE_PATH = playersPath;

const { getPublicIndexCoverage } = await import("../lib/public-index-coverage.ts");

function writeMeta(rows) {
  const db = new DatabaseSync(playersPath);
  db.exec("CREATE TABLE IF NOT EXISTS player_index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  for (const [key, value] of rows) {
    db.prepare("INSERT OR REPLACE INTO player_index_meta (key, value) VALUES (?, ?)").run(key, String(value));
  }
  db.close();
}

test("coverage reports nulls before the index has ever synced", async () => {
  writeMeta([]);
  assert.deepEqual(await getPublicIndexCoverage(), { total: null, syncedAt: null });
});

test("coverage serves the row count the index sync recorded", async () => {
  writeMeta([["row_count", 2970379], ["synced_at", 1756700000000]]);
  assert.deepEqual(await getPublicIndexCoverage(), { total: 2970379, syncedAt: 1756700000000 });
});

test("coverage rejects values that would publish a nonsense total", async () => {
  // A truncated or half-written sync must hide the figure, not show "0 accounts".
  for (const value of ["0", "-5", "not-a-number", "1.5"]) {
    writeMeta([["row_count", value], ["synced_at", 1756700000000]]);
    assert.equal((await getPublicIndexCoverage()).total, null, `row_count=${value}`);
  }
});

test("coverage reads one metadata key instead of recounting the index", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile("lib/public-index-coverage.ts", "utf8"));
  // The doc comment names COUNT(*) while explaining what is avoided, so only
  // executable SQL is checked.
  assert.doesNotMatch(source, /SELECT[^"`]*COUNT\s*\(/i);
  assert.match(source, /FROM player_index_meta/);
});