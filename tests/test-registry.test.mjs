import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

const TEST_FILE = /\.(test|spec)\.(ts|mts|cts|js|mjs|cjs|tsx|jsx)$/;

// The only entry points into the gate: `npm test` runs `pretest` and then `test`, and
// nothing else. A script outside this set never runs, so a file only it names is dead.
const ROOTS = ["pretest", "test"];

// Test files that are knowingly absent from package.json, with the reason each one
// is exempt. This list must stay empty in practice: an entry here is a claim that the
// file is covered some other way, and the reason has to say which way. A file only
// earns an entry if it genuinely cannot run as an npm script; anything that can run
// belongs in a script instead, because CI runs the same `npm test` gate.
const UNREGISTERED_BY_DESIGN = new Map([
  // "path/relative/to/repo.test.ts" -> "why it cannot be registered",
]);

function collectTestFiles() {
  // Include new source tests before staging, but exclude ignored local checkouts,
  // browser profiles and operator tools using the repository's own ignore rules.
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--deduplicate", "-z"], {
    encoding: "utf8",
  }).split("\0").filter((file) => TEST_FILE.test(file) && existsSync(file));
}

// Test files `npm test` would actually execute: the roots, plus every script they hand
// off to through `npm run <name>`. Scripts no root reaches are ignored on purpose, so a
// file listed only by such a script counts as dead.
async function reachableTestFiles(scripts) {
  const reachable = new Set();
  const queue = [...ROOTS];
  const visited = new Set();
  while (queue.length > 0) {
    const name = queue.pop();
    if (visited.has(name)) continue;
    visited.add(name);
    const body = scripts[name];
    if (!body) continue;
    for (const token of body.split(/\s+/)) {
      if (TEST_FILE.test(token)) reachable.add(token);
    }
    for (const [, target] of body.matchAll(/\bnpm\s+(?:run\s+)?([\w:.-]+)/g)) queue.push(target);
  }
  return reachable;
}

// `npm test` runs `pretest` and then an explicit test-file list, so a test file that no
// script reachable from either root names is silently dead: it passes locally, never
// runs in the gate, and regressions it was written to catch ship anyway. This walks the
// repository instead of trusting a hard-coded list, so a new test cannot be added
// without registering it.
test("every test file on disk is run by a script reachable from npm test", async () => {
  const { scripts } = JSON.parse(await readFile("package.json", "utf8"));
  const reachable = await reachableTestFiles(scripts);

  const onDisk = collectTestFiles().sort();

  // A reachable script may only name files that exist. A glob token such as
  // `tests/*.test.ts` is not one of them, so a script listing only globs registers
  // nothing while still reading like a registration.
  const unknown = [...reachable].filter((file) => !onDisk.includes(file)).sort();
  assert.deepEqual(unknown, [], `scripts name test files that do not exist: ${unknown.join(", ")}`);

  const missing = onDisk.filter(
    (file) => !reachable.has(file) && !UNREGISTERED_BY_DESIGN.has(file)
  );
  assert.deepEqual(missing, [], `test files that npm test never runs: ${missing.join(", ")}`);
});

// Guards the guard: an allow-list entry whose file npm test can reach, or that is gone
// from disk, means the exemption has been resolved and should be deleted, not left to
// rot.
test("the unregistered allow-list holds no entries that npm test can reach", async () => {
  const { scripts } = JSON.parse(await readFile("package.json", "utf8"));
  const reachable = await reachableTestFiles(scripts);
  const onDisk = new Set(collectTestFiles());

  const stale = [...UNREGISTERED_BY_DESIGN.keys()].filter(
    (file) => reachable.has(file) || !onDisk.has(file)
  );
  assert.deepEqual(stale, [], `stale allow-list entries: ${stale.join(", ")}`);
});

// An exemption the staleness check cannot audit is one nobody can review, so the reason
// has to say which way the file is covered.
test("every allow-list entry states why the file cannot be registered", () => {
  const unexplained = [...UNREGISTERED_BY_DESIGN].filter(
    ([, reason]) => typeof reason !== "string" || reason.trim() === ""
  ).map(([file]) => file);
  assert.deepEqual(unexplained, [], `allow-list entries without a reason: ${unexplained.join(", ")}`);
});
