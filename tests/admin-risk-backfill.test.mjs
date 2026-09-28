import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

// Every store the script opens is redirected into the fixture directory. A path that is
// absent is then absent only there, and a run that wrongly carries on can never reach the
// real /data tree.
const runBackfill = (directory, overrides = {}) => spawnSync(process.execPath, ["--experimental-strip-types",
  "--experimental-sqlite", "scripts/backfill-admin-risk.mjs"], { cwd: process.cwd(), encoding: "utf8", env: {
    ...process.env,
    SQLITE_PATH: join(directory, "players.db"),
    PROGRESSION_SQLITE_PATH: join(directory, "progression.db"),
    PROGRESSION_DB_PATH: "",
    ADMIN_ANALYTICS_SQLITE_PATH: join(directory, "admin.db"),
    BANS_SQLITE_PATH: join(directory, "bans.db"),
    REPORTS_SQLITE_PATH: join(directory, "reports.db"),
    ...overrides,
  } });

// A players store the script can actually score. It matters that this is a real schema:
// the unfixed script scores these rows before it re-checks the progression path, so the
// side effect under test is only reachable from a fixture the scoring loop survives.
const createScorablePlayers = (directory, rows) => {
  const players = new DatabaseSync(join(directory, "players.db"));
  try {
    players.exec(`
      CREATE TABLE players (
        aid INTEGER PRIMARY KEY,
        nickname TEXT,
        hours REAL,
        pmc_raids INTEGER,
        total_raids INTEGER,
        kd_ratio REAL,
        pmc_kd_ratio REAL,
        pmc_kills_per_raid REAL,
        pmc_survival_rate REAL,
        longest_win_streak INTEGER,
        level INTEGER,
        prestige INTEGER,
        pvp_stats_known INTEGER,
        profile_updated_at INTEGER,
        achievements TEXT,
        stats_json TEXT
      );
      CREATE TABLE mode_players (mode TEXT, aid INTEGER, stats_json TEXT);
      CREATE TABLE excluded_players (aid INTEGER PRIMARY KEY, reason TEXT, created_at INTEGER);
    `);
    const insert = players.prepare(`INSERT INTO players
      (aid, nickname, hours, pmc_raids, total_raids, kd_ratio, pmc_kd_ratio,
       pmc_kills_per_raid, pmc_survival_rate, longest_win_streak, level, prestige,
       pvp_stats_known, profile_updated_at, achievements, stats_json)
      VALUES (?, ?, 100, 100, 100, 1, 1, 2, 50, 10, 20, 0, 1, ?, NULL, '{}')`);
    const now = Date.now();
    for (let aid = 1; aid <= rows; aid += 1) insert.run(aid, `p${aid}`, now);
  } finally {
    players.close();
  }
};

test("admin risk backfill refuses a missing database instead of reporting an empty success", async (t) => {
  // A path that is present only has to survive `existsSync`: the guard runs before any
  // handle is opened, so an empty file is enough to stand in for a real database.
  const scenarios = [
    { label: "both databases missing", playersRows: 0, present: [] },
    { label: "progression database missing", playersRows: 3, present: ["players"] },
    { label: "players database missing", playersRows: 0, present: ["progression"] },
  ];

  for (const { label, playersRows, present } of scenarios) {
    await t.test(label, () => {
      const directory = mkdtempSync(join(tmpdir(), "admin-risk-backfill-"));
      try {
        if (playersRows > 0) createScorablePlayers(directory, playersRows);
        else if (present.includes("players")) writeFileSync(join(directory, "players.db"), "");
        if (present.includes("progression")) writeFileSync(join(directory, "progression.db"), "");

        const child = runBackfill(directory);
        const missing = present.includes("players") ? "progression.db" : "players.db";
        const subject = present.includes("players") ? "progression" : "players";
        const missingPath = join(directory, missing);

        assert.notEqual(child.status, 0, "a missing database must fail the run");
        assert.ok(child.stderr.includes(`Error: ${subject} database does not exist: ${missingPath}`),
          `expected a "${subject} database does not exist" error, got: ${child.stderr}`);
        assert.doesNotMatch(child.stdout, /"scored":/, "must not report a score at all");
        // The side effect the old tolerant skip allowed. Scoring the players rows reaches
        // `initializeAttachedSchemas`, which runs `ATTACH DATABASE ?` for the progression
        // path, and SQLite creates a missing file on attach. So a typo there did not just
        // skip a source: the run left an empty progression.db behind that every later run
        // then found, which is how the seasonal rows stayed unscored indefinitely.
        assert.equal(existsSync(missingPath), false, "the script must not create the database");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

test("admin risk backfill still scores a run whose databases are both present", () => {
  const directory = mkdtempSync(join(tmpdir(), "admin-risk-backfill-ok-"));
  try {
    createScorablePlayers(directory, 3);
    // The seasonal source needs the file itself: an empty store has no `player_profiles`
    // table, so it contributes nothing and every scored row comes from the players table.
    for (const path of ["progression.db", "bans.db", "reports.db"]) {
      new DatabaseSync(join(directory, path)).close();
    }

    const child = runBackfill(directory);
    assert.equal(child.status, 0, child.stderr);
    const summary = JSON.parse(child.stdout.trim());
    assert.equal(summary.scored, 3, "the guard must not fire on a valid run");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
