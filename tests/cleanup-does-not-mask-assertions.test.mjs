import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

// SQLite opens its files without FILE_SHARE_DELETE, so a handle that is still
// live when a suite cleans up makes the forced delete throw EPERM. Because the
// delete sits in a `finally`, that throw replaces the assertion failure that
// caused the cleanup: the report shows a locked temp path and no diff, and the
// real defect has to be found a second time.

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

test("a live SQLite handle makes a forced delete throw instead of removing the directory", () => {
  assert.equal(locked, "EPERM",
    "this suite is the regression gate for the Windows lock the guard exists for");
});

test("an unguarded cleanup delete reports EPERM and loses the failure that caused it", () => {
  const directory = mkdtempSync(join(tmpdir(), "cleanup-mask-"));
  const db = new DatabaseSync(join(directory, "live.db"));
  db.exec("CREATE TABLE t (a)");
  try {
    // The bare form: the finally throws, and the real assertion is discarded.
    assert.throws(() => {
      try {
        assert.fail("no such column: OLD.prestige");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }, { code: "EPERM" });

    // The guarded form the suite uses: the cleanup stays best effort, so the
    // real failure is what the report carries.
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
      if (line.includes("try {") && line.includes("catch {")) return;
      unguarded.push(`${name}:${index + 1}`);
    });
  }
  assert.deepEqual(unguarded, [],
    "wrap the delete in try/catch so a locked database cannot replace a real assertion failure");
});
