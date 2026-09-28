import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const TEST_FILE = /\.(test|spec)\.(ts|mts|cts|js|mjs|cjs|tsx|jsx)$/;

// Build output and vendored trees never hold source test files.
const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".next", ".open-next", "out", "coverage", "playwright-report",
]);

// Test files that are knowingly absent from package.json, with the reason each one
// is exempt. This list must stay empty in practice: an entry here is a claim that the
// file is covered some other way, and the reason has to say which way. A file only
// earns an entry if it genuinely cannot run as an npm script; anything that can run
// belongs in a script instead, because `npm test` is the whole gate in this repository
// (there is no CI).
const UNREGISTERED_BY_DESIGN = new Map([
  // "path/relative/to/repo.test.ts" -> "why it cannot be registered",
]);

async function collectTestFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await collectTestFiles(full));
    else if (TEST_FILE.test(entry.name)) found.push(full.split(path.sep).join("/"));
  }
  return found;
}

// `npm test` runs `pretest` and then an explicit test-file list, so a test file that
// no script names is silently dead: it passes locally, never runs in the gate, and
// regressions it was written to catch ship anyway. This walks the repository instead
// of trusting a hard-coded list, so a new test cannot be added without registering it.
test("every test file on disk is named by some package.json script", async () => {
  const { scripts } = JSON.parse(await readFile("package.json", "utf8"));
  // Any script counts, not just `test`/`pretest`: the contract is that a file is
  // reachable from `npm test`, and a test:* script it is also listed in satisfies that.
  const registered = new Set(
    Object.values(scripts).flatMap((value) => value.split(/\s+/)).filter((token) => TEST_FILE.test(token))
  );

  const onDisk = (await collectTestFiles(".")).sort();
  const missing = onDisk.filter(
    (file) => !registered.has(file) && !UNREGISTERED_BY_DESIGN.has(file)
  );

  assert.deepEqual(missing, [], `test files that no npm script runs: ${missing.join(", ")}`);
});

// Guards the guard: an allow-list entry that no longer describes a real unregistered
// file means the exemption has been resolved and should be deleted, not left to rot.
test("the unregistered allow-list holds no entries that are registered", async () => {
  const { scripts } = JSON.parse(await readFile("package.json", "utf8"));
  const registered = new Set(
    Object.values(scripts).flatMap((value) => value.split(/\s+/)).filter((token) => TEST_FILE.test(token))
  );
  const onDisk = new Set(await collectTestFiles("."));

  const stale = [...UNREGISTERED_BY_DESIGN.keys()].filter(
    (file) => registered.has(file) || !onDisk.has(file)
  );
  assert.deepEqual(stale, [], `stale allow-list entries: ${stale.join(", ")}`);
});
