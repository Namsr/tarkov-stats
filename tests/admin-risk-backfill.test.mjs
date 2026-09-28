import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const runBackfill = (env) => spawnSync(process.execPath, ["--experimental-strip-types", "--experimental-sqlite",
  "scripts/backfill-admin-risk.mjs"], { cwd: process.cwd(), encoding: "utf8", env: {
    ...process.env, PROGRESSION_DB_PATH: "", ...env,
  } });

// A path that is present only has to survive `existsSync`: the guard runs before
// any handle is opened, so an empty file is enough to stand in for a real database.
const scenarios = [
  { label: "both databases missing", present: [] },
  { label: "progression database missing", present: ["players"] },
  { label: "players database missing", present: ["progression"] },
];

test("admin risk backfill refuses a missing database instead of reporting an empty success", async (t) => {
  for (const { label, present } of scenarios) {
    await t.test(label, () => {
      const directory = mkdtempSync(join(tmpdir(), "admin-risk-backfill-"));
      try {
        const playersPath = join(directory, "players.db");
        const progressionPath = join(directory, "progression.db");
        if (present.includes("players")) writeFileSync(playersPath, "");
        if (present.includes("progression")) writeFileSync(progressionPath, "");

        const child = runBackfill({ SQLITE_PATH: playersPath, PROGRESSION_SQLITE_PATH: progressionPath });
        const missing = present.includes("players") ? progressionPath : playersPath;
        const subject = present.includes("players") ? "progression" : "players";

        assert.notEqual(child.status, 0, "a missing database must fail the run");
        assert.ok(child.stderr.includes(`Error: ${subject} database does not exist: ${missing}`),
          `expected a "${subject} database does not exist" error, got: ${child.stderr}`);
        assert.doesNotMatch(child.stdout, /"scored":0/, "must not report an empty success");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});
