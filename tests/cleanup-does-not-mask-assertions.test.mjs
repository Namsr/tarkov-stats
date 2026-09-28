import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

// SQLite opens its files without FILE_SHARE_DELETE, so on Windows a handle that
// is still live when a suite cleans up makes the forced delete throw EPERM.
// Because the delete sits in a `finally`, that throw replaces the assertion
// failure that caused the cleanup: the report shows a locked temp path and no
// diff, and the real defect has to be found a second time. POSIX unlink(2) has
// no such rule, so off Windows the same delete succeeds and the assertion
// failure is the one that surfaces. Both branches are asserted, so a platform
// that starts behaving like the other fails here instead of silently skipping.

const isWindows = process.platform === "win32";

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
  assert.equal(locked, isWindows ? "EPERM" : null, isWindows
    ? "this suite is the regression gate for the Windows lock the guard exists for"
    : "unlink(2) removes an open file, so the delete succeeds here and there is no lock to mask a failure with");
});

test("an unguarded cleanup delete loses the failure that caused it", () => {
  const directory = mkdtempSync(join(tmpdir(), "cleanup-mask-"));
  const db = new DatabaseSync(join(directory, "live.db"));
  db.exec("CREATE TABLE t (a)");
  try {
    // The bare form. On Windows the finally throws EPERM and the assertion is
    // discarded; on POSIX the delete succeeds and the assertion is what the
    // report carries, which is the only reason the guard is not visible there.
    assert.throws(() => {
      try {
        assert.fail("no such column: OLD.prestige");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }, isWindows ? { code: "EPERM" } : { message: "no such column: OLD.prestige" });

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

// The suites below open a DatabaseSync inside the test body and delete that same
// directory afterwards, so their cleanup can meet a live handle. The remaining
// suites in tests/ close every handle, or exit the process that owns it, on the
// line above the delete; a guard there would be unreachable code, so it is not
// required and not added.
const suitesThatCanMeetALiveHandle = [
  "arena-index-sync.test.mjs",
  "average-publication.test.ts",
  "leaderboard-cli.test.mjs",
  "player-index-sync.test.mjs",
  "pve-index-sync.test.mjs",
  "seasonal-index-sync.test.mjs",
];

test("every cleanup delete that can meet a live SQLite handle is guarded", () => {
  const unguarded = [];
  for (const name of suitesThatCanMeetALiveHandle) {
    const lines = readFileSync(join("tests", name), "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      // Line-scoped on purpose: a forced delete call, not a `force: true` that
      // belongs to a domain option such as getPublicProfile({ force: true }).
      if (!/(?:^|[^\w.$])rm(?:Sync)?\(/.test(line)) return;
      if (!line.includes("force: true")) return;
      // A guard counts only when `try` and `catch` share the delete's own line.
      // That is the shape every guarded call site in tests/ already uses, and
      // the strict reading is the one that keeps the gate sound: a wider window
      // would also accept a delete that merely sits near a try, so a real
      // violation could pass. The failure message carries the exact line.
      if (/\btry\s*\{/.test(line) && /\bcatch\b/.test(line)) return;
      unguarded.push(`${name}:${index + 1}`);
    });
  }
  assert.deepEqual(unguarded, [],
    "put the delete on one line inside try/catch, as in "
    + "`try { await rm(directory, { recursive: true, force: true }); } catch { }`, "
    + "so a locked database cannot replace a real assertion failure");
});
