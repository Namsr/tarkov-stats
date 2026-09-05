import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

test("materializer CLI performs an initial build, a persisted delta, and a no-op", () => {
  const directory = mkdtempSync(join(tmpdir(), "leaderboard-cli-"));
  const sourcePath = join(directory, "players.db");
  const progressionPath = join(directory, "progression.db");
  const publicationPath = join(directory, "leaderboards.db");
  try {
    const db = new DatabaseSync(sourcePath);
    db.exec(`
      CREATE TABLE excluded_players(aid INTEGER PRIMARY KEY);
      CREATE TABLE players(aid INTEGER PRIMARY KEY,nickname TEXT,profile_updated_at INTEGER,fetched_at INTEGER,
        pmc_killed_pmc INTEGER,pmc_deaths INTEGER,pmc_raids INTEGER,hours REAL,last_played_at INTEGER,
        pvp_stats_known INTEGER,pvp_stats_version INTEGER);
      CREATE TABLE mode_players(mode TEXT,aid INTEGER,nickname TEXT,profile_updated_at INTEGER,fetched_at INTEGER,
        pmc_killed_pmc INTEGER,pmc_deaths INTEGER,pmc_raids INTEGER,hours REAL,last_played_at INTEGER,
        pvp_stats_known INTEGER,pvp_stats_version INTEGER,stats_json TEXT,PRIMARY KEY(mode,aid));
      CREATE TABLE arena_mode_stats(aid INTEGER,arena_mode TEXT,hours REAL,games_count INTEGER,kills INTEGER,deaths INTEGER,
        kills_per_match REAL,upstream_version INTEGER,parser_version INTEGER,raw_json TEXT,fetched_at INTEGER,best_arp INTEGER,
        PRIMARY KEY(aid,arena_mode));
      INSERT INTO players VALUES(1,'Regular',1,200,30,5,20,100,200,1,1);
      INSERT INTO mode_players VALUES('pve',2,'PvE',1,200,40,4,20,120,200,1,1,'{}');
      INSERT INTO mode_players VALUES('arena',3,'Arena',1,200,NULL,NULL,NULL,NULL,NULL,0,0,'{}');
      INSERT INTO arena_mode_stats VALUES(3,'overall',50,NULL,NULL,NULL,NULL,1,2,'{}',200,1500);
      INSERT INTO arena_mode_stats VALUES(3,'blastGang',50,20,25,5,1.25,1,2,'{}',200,NULL);
      INSERT INTO arena_mode_stats VALUES(3,'teamFight',50,20,25,5,1.25,1,2,'{}',200,NULL);
      INSERT INTO arena_mode_stats VALUES(3,'lastHero',50,20,25,5,1.25,1,2,'{}',200,NULL);
      INSERT INTO arena_mode_stats VALUES(3,'checkpoint',50,20,25,5,1.25,1,2,'{}',200,NULL);
      INSERT INTO arena_mode_stats VALUES(3,'shootOutDuo',50,20,25,5,1.25,1,2,'{}',200,NULL);
    `);
    db.close();
    new DatabaseSync(progressionPath).close();

    const run = () => {
      const child = spawnSync(process.execPath, ["--experimental-strip-types", "--experimental-sqlite",
        "scripts/materialize-leaderboards.mjs"], { cwd: process.cwd(), encoding: "utf8", env: {
          ...process.env, SQLITE_PATH: sourcePath, PROGRESSION_SQLITE_PATH: progressionPath,
          LEADERBOARD_SQLITE_PATH: publicationPath, SEASONAL_ENABLED: "true", SEASONAL_CYCLE_ID: "s1",
          SEASONAL_STARTS_AT: "100", SEASONAL_UPSTREAM_CONTRACT: "direct_profile",
          LEADERBOARD_ACTIVITY_CUTOFF_MS: "100", LEADERBOARD_ARENA_ACTIVITY_CUTOFF_MS: "100",
        } });
      assert.equal(child.status, 0, child.stderr);
      return child.stdout.trim().split("\n").map((line) => JSON.parse(line));
    };

    const initial = run();
    assert.equal(initial.length, 8);
    assert.ok(initial.every((row) => row.kind === "full" && row.fullReason === "journal_initialized"));

    const changed = new DatabaseSync(sourcePath);
    changed.exec(`BEGIN;
      UPDATE players SET nickname='Regular2',pmc_killed_pmc=31 WHERE aid=1;
      UPDATE mode_players SET pmc_killed_pmc=41 WHERE mode='pve' AND aid=2;
      UPDATE arena_mode_stats SET kills=26 WHERE aid=3 AND arena_mode='teamFight';
      UPDATE mode_players SET stats_json='updated',fetched_at=201 WHERE mode='arena' AND aid=3;
      COMMIT;`);
    changed.close();
    const seasonal = new DatabaseSync(progressionPath);
    seasonal.prepare(`INSERT INTO player_profiles
      (mode,cycle_id,aid,nickname,profile_updated_at,last_access_at,lifetime_pvp_hours,
       experience,pmc_raids,scav_raids,pmc_survived,pmc_deaths,pmc_kills,killed_pmc,
       first_seen_at,last_seen_at,pmc_killed_pmc,pvp_stats_version,pvp_stats_parser_version,leaderboard_activity_at)
      VALUES ('seasonal','s1',4,'Season',200000,200000,50,1000,20,0,10,4,30,16,200000,200000,16,1,1,200000)`).run();
    seasonal.close();

    const delta = run();
    assert.ok(delta.filter((row) => row.scope !== "seasonal:s1")
      .every((row) => row.kind === "incremental" && row.sourceChanges === 1), JSON.stringify(delta));
    assert.equal(delta.find((row) => row.scope === "seasonal:s1")?.kind, "full");
    const seasonalUpdate = new DatabaseSync(progressionPath);
    seasonalUpdate.prepare(`UPDATE player_profiles SET profile_updated_at=200001,pmc_killed_pmc=17
      WHERE mode='seasonal' AND cycle_id='s1' AND aid=4`).run();
    seasonalUpdate.close();
    const seasonalDelta = run();
    assert.ok(seasonalDelta.filter((row) => row.scope !== "seasonal:s1")
      .every((row) => row.kind === "incremental" && row.sourceChanges === 0));
    assert.deepEqual(Object.fromEntries(Object.entries(seasonalDelta.find((row) => row.scope === "seasonal:s1"))
      .filter(([key]) => ["kind", "sourceChanges", "changedMembers"].includes(key))),
    { kind: "incremental", sourceChanges: 1, changedMembers: 1 });
    const idle = run();
    assert.ok(idle.every((row) => row.kind === "incremental" && row.sourceChanges === 0 && row.changedMembers === 0));

    const published = new DatabaseSync(publicationPath);
    const beforeUnavailable = published.prepare("SELECT scope,generation,generated_at FROM leaderboard_current ORDER BY scope").all();
    published.close();
    const unavailable = spawnSync(process.execPath, ["--experimental-strip-types", "--experimental-sqlite",
      "scripts/materialize-leaderboards.mjs"], { cwd: process.cwd(), encoding: "utf8", env: {
        ...process.env, SQLITE_PATH: sourcePath, PROGRESSION_SQLITE_PATH: join(directory, "missing.db"),
        LEADERBOARD_SQLITE_PATH: publicationPath, SEASONAL_ENABLED: "true", SEASONAL_CYCLE_ID: "s1",
        SEASONAL_STARTS_AT: "100", SEASONAL_UPSTREAM_CONTRACT: "direct_profile",
        LEADERBOARD_ACTIVITY_CUTOFF_MS: "100", LEADERBOARD_ARENA_ACTIVITY_CUTOFF_MS: "100",
      } });
    assert.notEqual(unavailable.status, 0);
    const unchanged = new DatabaseSync(publicationPath);
    assert.deepEqual(unchanged.prepare("SELECT scope,generation,generated_at FROM leaderboard_current ORDER BY scope").all(),
      beforeUnavailable);
    unchanged.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
