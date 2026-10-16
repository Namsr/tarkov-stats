import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { registerHooks, createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "next/server") return nextResolve("next/server.js", context);
  if (specifier.startsWith("@/")) return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
  try { return nextResolve(specifier, context); } catch (error) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });
const directory = mkdtempSync(join(tmpdir(), "risk-latency-"));
for (const [key, name] of [["SQLITE_PATH", "players"], ["BANS_SQLITE_PATH", "bans"], ["ADMIN_ANALYTICS_SQLITE_PATH", "admin"], ["PROGRESSION_SQLITE_PATH", "progression"], ["REPORTS_SQLITE_PATH", "reports"]]) process.env[key] = join(directory, `${name}.db`);
const { RegularRiskWorker, RegularRiskScheduler } = await import("../lib/admin/risk-worker.ts");
const { evaluateAndStoreRisk } = await import("../lib/admin/risk-service.ts");
const { getRiskEvaluation, readRiskEvaluation, saveRiskEvaluation } = await import("../lib/admin/moderation-db.ts");
const { riskScoreVersion } = await import("../lib/admin/risk-version.ts");
const { parseProfileStats } = await import("../lib/tarkov-api.ts");
const { getStore } = await import("../lib/db.ts");
const { persistRegularProfileSnapshot } = await import("../lib/regular-profile-capture.ts");
const { makePlayerSnapshot } = await import("../lib/ban-db.ts");
const { EVENT_ACHIEVEMENT_IDS } = await import("../lib/cheater-score.ts");
const { GET } = await import("../app/api/player/risk/route.ts");
const { NextRequest } = await import("next/server");

function input(updated = 1_800_000_000_000, parser = 2) {
  const profile = { aid: 42, updated, info: { nickname: "fixture", prestigeLevel: 1 }, achievements: {},
    pmcStats: { eft: { totalInGameTime: 100 * 3600, overAllCounters: { Items: [
      [["Sessions", "Pmc"], 1000], [["Deaths"], 100], [["ExitStatus", "Survived", "Pmc"], 800],
      [["Kills"], 900], [["KilledPmc"], 600], [["LongestWinStreak", "Pmc"], 5],
    ].map(([Key, Value]) => ({ Key, Value })) } } } };
  return { aid: 42, mode: "regular", cycleId: "persistent", stats: { ...parseProfileStats(profile), profileUpdatedAt: updated, pvpStatsParserVersion: parser }, achievementIds: [] };
}

test("risk endpoint diagnoses absence, storage errors and every freshness rejection with Server-Timing", async () => {
  const request = () => GET(new NextRequest("http://localhost/api/player/risk?aid=42&mode=regular"));
  assert.equal((await readRiskEvaluation({ aid: 42, mode: "regular", cycleId: "persistent" })).status, "missing");
  const absent = await request();
  assert.equal(absent.headers.get("X-Risk-Status"), "missing");
  assert.match(absent.headers.get("Server-Timing"), /total;dur=\d+/);
  await new Promise(setImmediate);
  assert.equal(existsSync(process.env.ADMIN_ANALYTICS_SQLITE_PATH), false, "a risk poll must not create an analytics database");
  const source = input();
  await persistRegularProfileSnapshot(makePlayerSnapshot(42, source.stats, [], source.stats.profileUpdatedAt), { strict: true });
  const fresh = { aid: 42, mode: "regular", cycleId: "persistent", score: 50, tier: "high", factors: [],
    scoreVersion: riskScoreVersion("regular", "persistent"), profileUpdatedAt: source.stats.profileUpdatedAt,
    profileParserVersion: 2, evaluatedAt: Date.now() };
  await saveRiskEvaluation(fresh);
  const db = new DatabaseSync(process.env.ADMIN_ANALYTICS_SQLITE_PATH);
  try {
    for (const [changes, reason] of [
      [{}, "ready"], [{ score_version: 0 }, "version_stale"],
      [{ evaluated_at: Date.now() - 6 * 60 * 60 * 1000 }, "expired"],
      [{ profile_updated_at: source.stats.profileUpdatedAt - 1 }, "profile_stale"],
      [{ profile_parser_version: 1 }, "parser_stale"], [{ factors_json: "broken" }, "read_error"],
    ]) {
      db.prepare("UPDATE risk_evaluations SET score_version=?, evaluated_at=?, profile_updated_at=?, profile_parser_version=?, factors_json=? WHERE aid=42").run(
        fresh.scoreVersion, fresh.evaluatedAt, fresh.profileUpdatedAt, fresh.profileParserVersion, "[]",
      );
      for (const [column, value] of Object.entries(changes)) db.prepare(`UPDATE risk_evaluations SET ${column}=? WHERE aid=42`).run(value);
      const response = await request();
      assert.equal(response.headers.get("X-Risk-Status"), reason);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      const payload = await response.json();
      assert.deepEqual(payload.identity, { aid: 42, mode: "regular", cycleId: "persistent" });
      assert.equal(payload.risk !== null, reason === "ready");
    }
    db.prepare("UPDATE risk_evaluations SET factors_json='[]' WHERE aid=42").run();
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function (sql) {
      if (sql.startsWith("SELECT * FROM progression_snapshots WHERE")) throw new Error("fixture snapshot read failed");
      return prepare.call(this, sql);
    };
    try {
      const response = await request();
      assert.equal(response.headers.get("X-Risk-Status"), "snapshot_read_error");
      assert.equal((await response.json()).risk, null);
    } finally {
      DatabaseSync.prototype.prepare = prepare;
    }
    db.exec("DROP TABLE risk_evaluations");
    assert.equal((await request()).headers.get("X-Risk-Status"), "read_error");
    db.exec((await import("../lib/admin/moderation-db.ts")).MODERATION_SCHEMA);
  } finally { db.close(); }
});

test("regular worker stores the same evidence as direct scoring and cannot overwrite a newer profile", async (t) => {
  const source = input();
  const store = await getStore();
  for (let aid = 100; aid < 140; aid++) await store.upsert(aid, source.stats, []);
  const expected = await evaluateAndStoreRisk(source);
  const worker = new RegularRiskWorker();
  t.after(() => worker.stop());
  assert.deepEqual(await worker.compute(source), expected);
  await worker.compute(input(source.stats.profileUpdatedAt + 1));
  await worker.compute(source);
  const saved = await getRiskEvaluation(source);
  assert.equal(saved.profileUpdatedAt, source.stats.profileUpdatedAt + 1);
  assert.equal(saved.score, expected.score);
});

test("scheduler shares duplicates, coalesces updates and retries the latest version after an older failure", async () => {
  const calls = [];
  const scheduler = new RegularRiskScheduler((source) => new Promise((resolve, reject) => calls.push({ source, resolve, reject })));
  const first = scheduler.evaluate(input(100));
  assert.equal(scheduler.evaluate(input(100)), first);
  await Promise.resolve();
  scheduler.evaluate(input(101));
  scheduler.evaluate(input(102));
  scheduler.evaluate(input(99));
  assert.equal(calls.length, 1);
  calls[0].reject(new Error("old version failed"));
  await Promise.resolve();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].source.stats.profileUpdatedAt, 102);
  scheduler.evaluate(input(102, 3));
  calls[1].resolve({ score: 1 });
  await Promise.resolve();
  assert.equal(calls[2].source.stats.pvpStatsParserVersion, 3);
  calls[2].resolve({ score: 2 });
  assert.deepEqual(await first, { score: 2 });
  const failed = scheduler.evaluate(input(103));
  await Promise.resolve();
  calls[3].reject(new Error("latest failed"));
  await assert.rejects(failed, /latest failed/);
  const retry = scheduler.evaluate(input(103));
  await Promise.resolve();
  calls[4].resolve({ score: 3 });
  await Promise.resolve();
  const next = scheduler.evaluate(input(104));
  assert.notEqual(next, retry, "a completed job cannot swallow a new version before its finally runs");
  assert.deepEqual(await retry, { score: 3 });
  await Promise.resolve();
  assert.equal(scheduler.evaluate(input(104)), next, "cleanup of the old job cannot delete its successor");
  calls[5].resolve({ score: 4 });
  assert.deepEqual(await next, { score: 4 });
});

test("scoring omits ignored event achievements before SQL and reports separate calculation stages", async () => {
  const events = [];
  const original = console.log;
  console.log = (event) => events.push(JSON.parse(event));
  const readIds = [];
  try {
    await evaluateAndStoreRisk({ ...input(), queuedAt: Date.now() - 100,
      achievementIds: [EVENT_ACHIEVEMENT_IDS.values().next().value, "achievement"],
      playerStore: { riskBaseline: async () => null, achievementRiskBaseline: async (ids) => {
        readIds.push(...ids); return { total: 40, achievements: [] };
      } },
    });
  } finally { console.log = original; }
  assert.deepEqual(readIds, ["achievement"]);
  const event = events.find((event) => event.operation === "risk_evaluation");
  for (const field of ["queue_ms", "store_open_ms", "cohort_ms", "achievements_ms", "risk_ms", "store_write_ms", "total_ms"]) assert.ok(Number.isFinite(event[field]), field);
  assert.ok(event.queue_ms >= 100);
  assert.equal(event.outcome, "success");
  assert.equal("aid" in event, false);
  assert.equal("nickname" in event, false);
});

test("background profile refresh saves its new version before scheduling its risk", async () => {
  const route = readFileSync("app/api/player/profile/route.ts", "utf8");
  const from = route.indexOf("async function refreshStoredRegularProfile(");
  const to = route.indexOf("async function refreshStoredPveProfile(", from);
  const ts = createRequire(import.meta.url)("typescript");
  const compiled = ts.transpileModule(route.slice(from, to), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const calls = [];
  const refresh = new Function("progressionFlightKey", "singleFlight", "regularBackgroundRefreshes", "getPublicProfile", "parseProfileStats", "PLAYER_LEVELS_V2026_07_22", "persistRegularProfileSnapshot", "makePlayerSnapshot", "evaluateRegularRiskInBackground", "getRiskEvaluation", "riskScoreVersion", `${compiled}; return refreshStoredRegularProfile;`)(
    () => "key", (_map, _key, callback) => callback(), new Map(), async () => ({ profile: { achievements: { achievement: true } } }),
    () => input(200).stats, [], async () => calls.push("saved"), (_aid, stats) => ({ stats }),
    async (source) => { calls.push("risk"); assert.equal(source.stats.profileUpdatedAt, 200); assert.deepEqual(source.achievementIds, ["achievement"]); },
    async () => null, () => 3,
  );
  await refresh(42);
  assert.deepEqual(calls, ["saved", "risk"]);
});
