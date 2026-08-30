import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node 24 exposes node:sqlite at runtime; project types target Node 20.
import { DatabaseSync } from "node:sqlite";
// @ts-expect-error Direct Node TypeScript tests require explicit extensions.
import { initializeSeasonalSchema } from "../lib/seasonal/storage.ts";
// @ts-expect-error Direct Node TypeScript tests require explicit extensions.
import { assembleProgressionTimeline, D1_POPULATION_CHUNK_CHARS, d1PopulationSnapshot, materializeD1PopulationSnapshot, materializeSqlitePopulationSnapshot } from "../lib/seasonal/progression-db.ts";
// @ts-expect-error Direct Node TypeScript tests require explicit extensions.
import { materializeScheduledD1Population } from "../lib/seasonal/population-scheduler.ts";

function seed(db: DatabaseSync, mode = "regular", cycleId = "persistent") {
  const profile = db.prepare(`INSERT INTO player_profiles (
    mode, cycle_id, aid, nickname, profile_updated_at, last_access_at, lifetime_pvp_hours,
    experience, pmc_raids, scav_raids, pmc_survived, pmc_deaths, pmc_kills, killed_pmc,
    first_seen_at, last_seen_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`);
  const snapshot = db.prepare(`INSERT INTO progression_snapshots (
    mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at, local_date,
    nickname, experience, pmc_raids, pmc_survived, pmc_deaths, pmc_kills, killed_pmc,
    longest_win_streak, prestige
  ) VALUES (?, ?, ?, ?, ?, ?, '2026-08-12', ?, ?, ?, ?, ?, ?, ?, 2, 0)`);
  for (let aid = 1; aid <= 105; aid += 1) {
    profile.run(mode, cycleId, aid, `p${aid}`, aid, aid, 100, aid * 1_000, 10, 5, 5, 20, 5, aid, aid);
    snapshot.run(mode, cycleId, aid, aid, aid, aid, `p${aid}`, aid * 1_000, 10, 5, 5, 20, 5);
  }
  const point = db.prepare("SELECT id FROM progression_snapshots WHERE mode = ? AND cycle_id = ? AND aid = 1").get(mode, cycleId)!.id;
  db.prepare(`INSERT INTO progression_intervals (
    mode, cycle_id, aid, from_snapshot_id, to_snapshot_id, ended_at, local_date, elapsed_days,
    status, experience, pmc_raids, scav_raids, pmc_survived, pmc_deaths, pmc_kills, killed_pmc, confidence
  ) VALUES (?, ?, 1, ?, ?, 100, '2026-08-12', 1, 'valid', 1000, 10, 0, 5, 5, 20, 5, 1)`)
    .run(mode, cycleId, point, point);
}

test("SQLite population publication is atomic and preserves the last good generation", () => {
  const db = new DatabaseSync(":memory:");
  initializeSeasonalSchema(db);
  seed(db);
  db.prepare(`UPDATE progression_snapshots
    SET achievements = '[{"id":"seasonal-ach","unlockedAt":100}]'`).run();
  const first = materializeSqlitePopulationSnapshot(db, "regular", "persistent", 100);
  assert.equal(first.generation, 100);
  const payload = JSON.parse(String(db.prepare("SELECT payload FROM progression_population_generations").get()!.payload));
  assert.equal(Object.keys(payload.metrics).length, 10);
  assert.ok(payload.metrics.xp.overall.length > 0);
  assert.equal(payload.metrics.xp.byHours.length, 8);
  assert.equal(payload.riskBaselines.length, 8);
  assert.equal(payload.achievementBaseline.achievements[0].stdHours, 0);
  assert.equal(payload.progressionPercentiles["2026-08-12"].pmcRaidsPerDay.length, 101);

  db.exec(`CREATE TRIGGER reject_population_publish BEFORE UPDATE ON progression_population_current
    BEGIN SELECT RAISE(ABORT, 'publish failed'); END`);
  assert.throws(() => materializeSqlitePopulationSnapshot(db, "regular", "persistent", 101), /publish failed/);
  assert.equal(db.prepare("SELECT generation FROM progression_population_current").get()!.generation, 100);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM progression_population_generations").get()!.n, 1);
});

class FakeStatement {
  args: unknown[] = [];
  db: DatabaseSync;
  sql: string;
  constructor(db: DatabaseSync, sql: string) { this.db = db; this.sql = sql; }
  bind(...args: unknown[]) { this.args = args; return this; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async run() { const result = this.db.prepare(this.sql).run(...this.args); return { meta: { changes: Number(result.changes) } }; }
}

class FakeD1 {
  db: DatabaseSync;
  lastBatchSize = 0;
  constructor(db: DatabaseSync) { this.db = db; }
  prepare(sql: string) { return new FakeStatement(this.db, sql); }
  async batch(statements: FakeStatement[]) {
    this.lastBatchSize = statements.length;
    this.db.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

test("D1 population storage publishes the same versioned snapshot contract", async () => {
  const db = new DatabaseSync(":memory:");
  initializeSeasonalSchema(db);
  seed(db, "seasonal", "s1");
  const d1 = new FakeD1(db);
  const result = await materializeD1PopulationSnapshot(d1, "seasonal", "s1", 200);
  assert.deepEqual(result, { generation: 200, generatedAt: 200 });
  assert.ok(d1.lastBatchSize <= 100, "atomic publication stays within D1's batch statement budget");
  const current = db.prepare("SELECT generation, generated_at FROM progression_population_current").get();
  assert.equal(current!.generation, 200);
  assert.equal(current!.generated_at, 200);
  assert.match(String(db.prepare("SELECT payload FROM progression_population_generations").get()!.payload), /^chunks:\d+$/);
  const chunks = db.prepare("SELECT payload FROM progression_population_chunks ORDER BY chunk_index").all() as { payload: unknown }[];
  assert.ok(chunks.length > 0);
  assert.ok(chunks.every((row) => String(row.payload).length <= D1_POPULATION_CHUNK_CHARS));
  assert.ok(chunks.every((row) => Buffer.byteLength(String(row.payload), "utf8") < 2_000_000));
  const published = await d1PopulationSnapshot(d1, "seasonal", "s1");
  assert.equal(published?.generation, 200);
});

test("D1 without the snapshot migration safely reports warming", async () => {
  const db = new DatabaseSync(":memory:");
  const published = await d1PopulationSnapshot(new FakeD1(db), "seasonal", "s1");
  assert.equal(published, null);
});

test("personal revisions change only for timeline-relevant updates of that identity", () => {
  const db = new DatabaseSync(":memory:");
  initializeSeasonalSchema(db);
  seed(db);
  const revision = (aid: number) => Number(db.prepare(`SELECT revision FROM progression_personal_revisions
    WHERE mode = 'regular' AND cycle_id = 'persistent' AND aid = ?`).get(aid)!.revision);
  const targetBefore = revision(1);
  const foreignBefore = revision(2);
  db.prepare(`UPDATE progression_snapshots SET stats_json = '{"enriched":true}'
    WHERE mode = 'regular' AND cycle_id = 'persistent' AND aid = 1`).run();
  assert.equal(revision(1), targetBefore + 1);
  assert.equal(revision(2), foreignBefore);
  const enriched = revision(1);
  db.prepare(`UPDATE player_profiles SET last_access_at = last_access_at + 1
    WHERE mode = 'regular' AND cycle_id = 'persistent' AND aid = 1`).run();
  assert.equal(revision(1), enriched, "access-only updates do not invalidate timeline content");
  db.prepare(`UPDATE player_profiles SET lifetime_pvp_hours = lifetime_pvp_hours + 1
    WHERE mode = 'regular' AND cycle_id = 'persistent' AND aid = 1`).run();
  assert.equal(revision(1), enriched + 1);
});

test("capture and operator paths never materialize shared progression population", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const path of [
    "app/api/player/profile/route.ts",
    "app/api/operator/seasonal/profile/route.ts",
    "app/api/operator/seasonal/profile-sync/route.ts",
    "app/api/operator/seasonal/refresh/route.ts",
    "app/api/operator/seasonal/run/route.ts",
    "lib/seasonal/helper-api.ts",
  ]) {
    assert.doesNotMatch(await readFile(path, "utf8"), /refreshProgressionAfterCapture|refreshSeasonalDailyAggregates/);
  }
});

test("public timeline SQL is aid-scoped and never queries risk population live", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile("lib/seasonal/progression-db.ts", "utf8");
  assert.match(source, /TIMELINE_SNAPSHOT_SQL[\s\S]*WHERE s\.mode = \? AND s\.cycle_id = \? AND s\.aid = \?/);
  assert.match(source, /TIMELINE_INTERVAL_SQL[\s\S]*WHERE i\.mode = \? AND i\.cycle_id = \? AND i\.aid = \?/);
  assert.match(source, /DETAIL_INTERVAL_SQL[\s\S]*WHERE i\.mode = \? AND i\.cycle_id = \? AND i\.aid = \?/);
  assert.doesNotMatch(source, /getSeasonalRiskBaseline|getSeasonalAchievementBaseline/);
  assert.match(source, /d1PopulationSnapshot\(d1, input\.mode, input\.cycleId\)/);
  assert.match(source, /sqlitePopulationSnapshot\(sqliteDb, input\.mode, input\.cycleId\)/);
});

test("VPS delays and deprioritizes the isolated population worker", async () => {
  const { readFile } = await import("node:fs/promises");
  const start = await readFile("scripts/start-web.mjs", "utf8");
  const worker = await readFile("scripts/materialize-progression-population.mjs", "utf8");
  assert.match(start, /spawn\(process\.execPath,[\s\S]*materialize-progression-population\.mjs/);
  assert.match(start, /setPriority\(progressionMaterializer\.pid, 19\)/);
  assert.match(worker, /const intervalMs = 21_600_000/);
  assert.match(worker, /PROGRESSION_MATERIALIZE_INITIAL_DELAY_MS/);
  assert.match(worker, /: 300_000/);
  assert.match(worker, /if \(running\) return \{ skipped: true \}/);
  assert.match(worker, /setInterval\(\(\) => void materializeProgressionPopulation\("interval"\), intervalMs\)/);
  assert.match(worker, /setTimeout\(resolve, initialDelayMs\)/);
  assert.match(worker, /await materializeProgressionPopulation\("startup"\)/);
});

test("Cloudflare uses a non-public two-hour scheduled D1 lifecycle", async () => {
  const { readFile } = await import("node:fs/promises");
  const wrangler = await readFile("wrangler.jsonc", "utf8");
  const worker = await readFile("custom-worker.ts", "utf8");
  assert.match(wrangler, /"main": "custom-worker\.ts"/);
  assert.match(wrangler, /"crons": \["0 \*\/2 \* \* \*"\]/);
  assert.match(worker, /fetch: handler\.fetch/);
  assert.match(worker, /scheduled\(event(?:\s*:[^,]+)?, env(?:\s*:[^,]+)?, ctx(?:\s*:[^)]+)?\)/);
  assert.deepEqual(await materializeScheduledD1Population({}, 1), { skipped: true });
});

test("missing population snapshot returns personal lines with an exact warming contract", async () => {
  const timeline = await assembleProgressionTimeline(
    { mode: "regular", cycleId: "persistent", aid: 7 },
    [{ aid: 7, point_id: 1, local_date: "2026-08-12", observed_at: 100, experience: 1_000,
      pmc_raids: 10, level: 5, pmc_survived: 5, pmc_deaths: 5, pmc_kills: 20,
      killed_pmc: 5, stats_json: "{}", series_id: 1, lifetime_hours: 100 }],
    [], [],
    { nickname: "p7", experience: 1_000, pmc_raids: 10, scav_raids: 0, pmc_survived: 5,
      pmc_deaths: 5, pmc_kills: 20, killed_pmc: 5, pmc_killed_pmc: null, pmc_kd_ratio: null,
      pvp_stats_known: null, lifetime_pvp_hours: 100, prestige: 0, longest_win_streak: 2, achievements: "[]" },
    { snapshots: 1, first_observed_at: 100, last_observed_at: 100 },
    { all_intervals: 0, changed_intervals: 0, raid_intervals: 0, tempo_points: 0, form_points: 0 },
    null, null,
  );
  assert.deepEqual(timeline.comparison, { status: "warming", generation: null, generatedAt: null });
  assert.equal(timeline.metrics.xp!.player.length, 1);
  assert.deepEqual(timeline.metrics.xp!.nearby, []);
  assert.deepEqual(timeline.metrics.xp!.overall, []);
  assert.equal(timeline.risk.progression, null);
  assert.deepEqual(timeline.risk.markers, []);
});

test("materialized percentiles prevent self-ranking and preserve achievement risk", async () => {
  const percentileValues = Object.fromEntries([
    "killedPmcPerRaid", "pvpKd", "survivalRate", "xpPerPmcRaid", "allPmcKillsPerRaid", "pmcRaidsPerDay",
  ].map((metric) => [metric, Array(101).fill(0)]));
  const population = {
    generation: 9,
    generatedAt: 9,
    payload: {
      metrics: {},
      riskBaselines: [{ min: 100, max: 200, baseline: { n: 0, metrics: {} } }],
      progressionPercentiles: { "2026-08-12": percentileValues },
      achievementBaseline: {
        eligibleN: 30,
        seasonStartsAt: 1,
        achievements: [{ id: "seasonal-ach", owners: 10, eligibleN: 30, samplePct: 1,
          meanHours: 1_000, stdHours: 100, earlyHours: 500, unlockDayP20: 10, timestampOwners: 10 }],
      },
    },
  };
  const profile = {
    nickname: "p7", experience: 1_000, pmc_raids: 10, scav_raids: 0, pmc_survived: 5,
    pmc_deaths: 5, pmc_kills: 20, killed_pmc: 5, pmc_killed_pmc: null, pmc_kd_ratio: null,
    pvp_stats_known: null, lifetime_pvp_hours: 100, prestige: 0, longest_win_streak: 2,
    achievements: JSON.stringify([{ id: "seasonal-ach", unlockedAt: 100 }]),
  };
  const args = [
    { mode: "seasonal", cycleId: "s1", aid: 7 }, [], [],
    [{ aid: 7, local_date: "2026-08-12", ended_at: 100, elapsed_days: 1, status: "valid",
      experience: 100_000, pmc_raids: 10, scav_raids: 0, pmc_survived: 10, pmc_deaths: 0,
      pmc_kills: 100, killed_pmc: 50, pmc_killed_pmc: 50 }],
    profile, { snapshots: 1, first_observed_at: 1, last_observed_at: 100 },
    { all_intervals: 1, changed_intervals: 1, raid_intervals: 1, tempo_points: 1, form_points: 1 },
    1, population,
  ] as const;
  const ready = await assembleProgressionTimeline(...args);
  assert.ok((ready.risk.progression ?? 0) > 0, "shared percentiles rank the extreme interval above its population");
  assert.ok(ready.risk.markers.length > 0);

  const withoutAchievement = structuredClone(args);
  withoutAchievement[4].achievements = "[]";
  const plain = await assembleProgressionTimeline(...withoutAchievement);
  assert.ok(ready.risk.static > plain.risk.static, "materialized achievement baseline remains part of static risk");
});
