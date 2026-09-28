import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

// SQLite opens its files without FILE_SHARE_DELETE, so on Windows a handle that
// is still live when a suite cleans up makes the forced delete throw. Because the
// delete sits in a `finally`, that throw replaces the assertion failure that
// caused the cleanup: the report shows a locked temp path and no diff, and the
// real defect has to be found a second time. POSIX unlink(2) has no such rule, so
// off Windows the same delete succeeds and the assertion failure is the one that
// surfaces. Both branches are asserted, so a platform that starts behaving like
// the other fails here instead of silently skipping.

const isWindows = process.platform === "win32";
// Windows names the lock EPERM, and EBUSY when an on-access scanner or an indexer
// is holding the file. rmSync defaults to maxRetries: 0, so either one surfaces
// on the first attempt, and a gate whose whole job is to run on Windows would
// flake on a locked CI worker if it accepted only the code measured here.
const lockCodes = new Set(["EPERM", "EBUSY"]);

function lockedDeleteCode() {
  const directory = mkdtempSync(join(tmpdir(), "cleanup-lock-"));
  const db = new DatabaseSync(join(directory, "live.db"));
  db.exec("CREATE TABLE t (a)");
  let code = null;
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    code = error.code;
  } finally {
    // The handle goes first, so the directory is removable and nothing is left
    // locked for the rest of the run.
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
  return code;
}

const locked = lockedDeleteCode();

test("a live SQLite handle makes a forced delete throw on Windows and succeed on POSIX", () => {
  assert.ok(isWindows ? lockCodes.has(locked) : locked === null,
    isWindows
      ? `this suite is the regression gate for the Windows lock the guard exists for, got ${locked}`
      : "unlink(2) removes an open file, so the delete succeeds here and there is no lock to mask a failure with");
});

test("an unguarded cleanup delete loses the failure that caused it", () => {
  const directory = mkdtempSync(join(tmpdir(), "cleanup-mask-"));
  const db = new DatabaseSync(join(directory, "live.db"));
  db.exec("CREATE TABLE t (a)");
  try {
    // The bare form. On Windows the finally throws and the assertion is
    // discarded; on POSIX the delete succeeds and the assertion is what the
    // report carries, which is the only reason the guard is not visible there.
    assert.throws(() => {
      try {
        assert.fail("no such column: OLD.prestige");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
      // The code the probe above observed, rather than a hardcoded one, so the
      // two tests cannot disagree about which code Windows reports.
    }, isWindows ? { code: locked } : { message: "no such column: OLD.prestige" });

    // The guarded form the suite uses: the cleanup stays best effort, so the
    // real failure is what the report carries on either platform.
    assert.throws(() => {
      try {
        assert.fail("no such column: OLD.prestige");
      } finally {
        try { rmSync(directory, { recursive: true, force: true }); } catch { /* SQLite keeps the adapter open. */ }
      }
    }, { message: "no such column: OLD.prestige" });
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

// A forced delete is an rm call with a `force: true` next to it. Both halves are
// matched through one window rather than one line, because an options object
// spread over several lines is ordinary formatting, and because a whitespace
// literal like "force: true" misses the `rm(dir,{recursive:true,force:true})`
// that suites actually write. The call regex takes the `fs.` and `fs.promises.`
// forms as well, which are the most likely way a violating suite names the
// delete, and still skips a property call such as `store.rm(`.
const WINDOW = 200;
const rmCall = /(?<![\w$])(?:\w+\.)*rm(?:Sync)?\(/g;
const forcedOption = /\bforce\s*:\s*true\b/;
const tryBlock = /\btry\s*\{/g;
const catchClause = /\bcatch\b/;
const catchOrFinally = /\b(?:catch|finally)\b/;

// The delete is guarded when the nearest `try` before it still owns it where the
// `catch` after it arrives. A `catch` or a `finally` between the two means
// something closed that block first, so the delete is in a handler or beside a
// try/catch that already ended, not inside a guard. Reading both halves through
// the same window the flag uses keeps the two consistent, and the strict reading
// is the one that keeps the gate sound: a delete that merely sits near a try
// still fails here, because a false pass hides a real violation.
function isGuarded(source, at) {
  const before = source.slice(Math.max(0, at - WINDOW), at);
  let opened = -1;
  for (const match of before.matchAll(tryBlock)) opened = match.index;
  if (opened === -1 || catchOrFinally.test(before.slice(opened))) return false;
  return catchClause.test(source.slice(at, at + WINDOW));
}

// The lines each unguarded forced delete is written on, empty when the suite has
// none. A domain option such as getPublicProfile({ force: true }) never reaches
// this: it is not inside the window of an rm call.
function unguardedDeleteLines(source) {
  const lines = [];
  for (const match of source.matchAll(rmCall)) {
    if (!forcedOption.test(source.slice(match.index, match.index + WINDOW))) continue;
    if (isGuarded(source, match.index)) continue;
    lines.push(source.slice(0, match.index).split(/\r?\n/).length);
  }
  return lines;
}

// The suites below force-delete a directory they opened a DatabaseSync into, so
// their cleanup can meet a live handle and the delete has to be best effort. Six
// open that handle in the test body; the other seven reach it through a module
// that caches it for the life of the process, which is what
// sqlite-handle-recovery says its own openers do, and which is why they are held
// to the same rule rather than counted as safe.
const suitesWhoseDeleteNeedsAGuard = [
  "tests/arena-index-sync.test.mjs",
  "tests/average-publication.test.ts",
  "tests/home-showcase-config-api.test.mjs",
  "tests/leaderboard-cli.test.mjs",
  "tests/player-index-sync.test.mjs",
  "tests/pve-index-sync.test.mjs",
  "tests/seasonal-average-buckets.test.ts",
  "tests/seasonal-average-materialize.test.ts",
  "tests/seasonal-average.test.ts",
  "tests/seasonal-cohort.test.ts",
  "tests/seasonal-index-sync.test.mjs",
  "tests/seasonal-progression.test.ts",
  "tests/sqlite-handle-recovery.test.mjs",
];

// The other suites that force-delete a temp directory close every handle, or
// wait for the child process that owns it, before the delete runs: a guard there
// would be unreachable code. Seven of the suites above carry one anyway, so the
// real distinction is not guarded versus unguarded, it is whether a handle can
// still be live at the delete.
const suitesThatCloseTheHandleOrTheProcessFirst = [
  "tests/admin-analytics.test.ts",
  "tests/admin-data-audit.test.mjs",
  "tests/admin-moderation.test.ts",
  "tests/admin-risk-backfill.test.mjs",
  "tests/arena-moderation-isolation.test.ts",
  "tests/arena-profile-sync.test.mjs",
  "tests/deploy-wrapper.test.mjs",
  "tests/leaderboard-publication.test.ts",
  "tests/leaderboard-warmup.test.mjs",
  "tests/profile-mastery.test.ts",
  "tests/profile-queue-wrapper.test.mjs",
  "tests/progression-timeline.test.ts",
  "tests/pve-profile-sync.test.mjs",
  "tests/regular-profile-sync.test.mjs",
  "tests/regular-progression.test.ts",
  "tests/seasonal-profile-sync.test.mjs",
  "tests/seasonal-storage.test.ts",
  "tests/showcase-store.test.mjs",
  "tests/system-metrics.test.ts",
  "tests/tarkov-json-api.test.mjs",
];

// This suite has to leave the handle live at the delete, because reproducing the
// masking is what it is for, so it cannot follow the rule it enforces.
const suitesThatReproduceTheMasking = [
  "tests/cleanup-does-not-mask-assertions.test.mjs",
];

const classified = new Set([
  ...suitesWhoseDeleteNeedsAGuard,
  ...suitesThatCloseTheHandleOrTheProcessFirst,
  ...suitesThatReproduceTheMasking,
]);

test("every cleanup delete that can meet a live SQLite handle is guarded", () => {
  const unguarded = [];
  for (const name of suitesWhoseDeleteNeedsAGuard) {
    for (const line of unguardedDeleteLines(readFileSync(name, "utf8"))) {
      unguarded.push(`${name}:${line}`);
    }
  }
  assert.deepEqual(unguarded, [],
    "put the delete on one line inside try/catch, as in "
    + "`try { await rm(directory, { recursive: true, force: true }); } catch { }`, "
    + "so a locked database cannot replace a real assertion failure");
});

// A guarded delete and an unguarded one look the same to a scan of the text, so
// a blanket scan over every suite would report a suite that closes the handle on
// the line above the delete, as arena-profile-sync does, next to a real
// violation. What the scan can enforce is classification instead: a suite with a
// forced delete has to say which side it is on. The directories are the two
// `npm test` runs suites from, and a new one has to be added here or it is
// invisible. A walk of the whole tree is not an option: `.next/standalone/tests`
// is a build copy of the same suites.
const suiteDirectories = ["tests", "lib/seasonal"];

test("every suite that force-deletes a temp directory is classified", () => {
  const unclassified = [];
  for (const directory of suiteDirectories) {
    for (const name of readdirSync(directory)) {
      if (!/\.test\.(?:mjs|ts)$/.test(name)) continue;
      const suite = `${directory}/${name}`;
      if (classified.has(suite)) continue;
      if (unguardedDeleteLines(readFileSync(suite, "utf8")).length === 0) continue;
      unclassified.push(suite);
    }
  }
  assert.deepEqual(unclassified, [],
    "classify the suite: guard the delete if a handle can be live when it runs, "
    + "or record why no handle can be");
});
