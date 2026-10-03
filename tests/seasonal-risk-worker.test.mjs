import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
    }
    return nextResolve(specifier, context);
  },
});
const directory = mkdtempSync(join(tmpdir(), "seasonal-risk-worker-"));
process.env.SQLITE_PATH = join(directory, "players.db");
process.env.BANS_SQLITE_PATH = join(directory, "bans.db");
process.env.PROGRESSION_SQLITE_PATH = join(directory, "progression.db");
process.env.ADMIN_ANALYTICS_SQLITE_PATH = join(directory, "admin.db");
process.env.REPORTS_SQLITE_PATH = join(directory, "reports.db");
process.env.RISK_WORKER_TEST_MARKER = join(directory, "busy");
const { SeasonalRiskWorker } = await import("../lib/admin/risk-worker.ts");
const { seasonalRiskInput, evaluateAndStoreSeasonalRisk } = await import("../lib/admin/risk-service.ts");
const { ComputeUnavailableError } = await import("../lib/compute-worker.ts");
const { createSqliteSeasonalStore, upsertSqliteSeasonCycle } = await import("../lib/seasonal/storage.ts");
const { getRiskEvaluation } = await import("../lib/admin/moderation-db.ts");
const entry = resolve("tests/fixtures/risk-worker.mjs");
const profile = (aid = 42, cycleId = "s1") => ({
  mode: "seasonal", cycleId, aid, nickname: "fixture", profileUpdatedAt: 1700000000000, lastAccessAt: 1700000000000,
  lifetimePvpHours: 100,
  counters: { experience: 10000, pmcRaids: 100, scavRaids: 1, pmcSurvived: 50, pmcDeaths: 50, pmcKills: 100, killedPmc: 20 },
  staticSignals: { prestige: 2, longestWinStreak: 5, achievementIds: ["achievement"] },
});
const input = (action) => ({ ...seasonalRiskInput(profile()), stats: { ...seasonalRiskInput(profile()).stats, nickname: action } });

test("worker risk matches direct calculation, preserves hidden achievements and stores the correct identity", async (t) => {
  const db = new DatabaseSync(process.env.PROGRESSION_SQLITE_PATH);
  const store = createSqliteSeasonalStore(db);
  upsertSqliteSeasonCycle(db, { mode: "seasonal", cycleId: "s1", startsAt: 1699900000000, endsAt: null, enabled: true, upstreamContract: null });
  for (let aid = 1; aid <= 45; aid++) {
    const source = profile(aid);
    source.lifetimePvpHours += aid / 10;
    source.seasonalAchievements = [{ id: "achievement", unlockedAt: 1699990000000 + aid }];
    await store.upsertProfile(source);
    await store.captureSnapshot(source);
  }
  const source = profile();
  Object.defineProperty(source, "seasonalAchievements", { value: [{ id: "achievement", unlockedAt: 1699900000001 }], enumerable: false });
  const expected = await evaluateAndStoreSeasonalRisk(source, 123);
  const worker = new SeasonalRiskWorker();
  t.after(() => { worker.stop(); db.close(); });
  assert.deepEqual(await worker.compute(seasonalRiskInput(source, 456)), expected);
  const stored = await getRiskEvaluation({ aid: source.aid, mode: "seasonal", cycleId: "s1" });
  assert.equal(stored.evaluatedAt, 456);
  assert.equal(stored.profileUpdatedAt, source.profileUpdatedAt);
  assert.equal(stored.score, expected.score);
  assert.equal(await getRiskEvaluation({ aid: source.aid, mode: "regular", cycleId: "persistent" }), null);
  const transferred = new SeasonalRiskWorker({ entry });
  t.after(() => transferred.stop());
  const result = await transferred.compute(seasonalRiskInput(source));
  assert.deepEqual(result.input.achievementUnlocks, source.seasonalAchievements);
  assert.notEqual(result.pid, process.pid);
});

test("HTTP remains responsive during risk SQL; the queue is bounded and reuses one child", async (t) => {
  const worker = new SeasonalRiskWorker({ entry, maxPending: 2 });
  t.after(() => worker.stop());
  const server = createServer((_request, response) => response.end("ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  let completed = false;
  const first = worker.compute(input("hold")).then((result) => { completed = true; return result; });
  const jobs = Promise.all([first, worker.compute(input("normal"))]);
  jobs.catch(() => {});
  await assert.rejects(worker.compute(input("overflow")), ComputeUnavailableError);
  const marker = process.env.RISK_WORKER_TEST_MARKER;
  const deadline = Date.now() + 10_000;
  while (!existsSync(marker) && Date.now() < deadline) await delay(10);
  assert.ok(existsSync(marker));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/healthz`, { signal: AbortSignal.timeout(5000) });
  assert.equal(await response.text(), "ok");
  assert.equal(completed, false);
  writeFileSync(`${marker}.release`, "release");
  const results = await jobs;
  assert.equal(results[0].pid, results[1].pid);
});

test("errors, crash and timeout preserve the last risk and permit a fresh worker", async (t) => {
  await evaluateAndStoreSeasonalRisk(profile(), 789);
  const worker = new SeasonalRiskWorker({ entry, timeoutMs: 3000 });
  t.after(() => worker.stop());
  const initial = await worker.compute(input("normal"));
  await assert.rejects(worker.compute(input("error")), /fixture SQL failure/);
  assert.equal((await worker.compute(input("normal"))).pid, initial.pid);
  const results = await Promise.allSettled([worker.compute(input("crash")), worker.compute(input("queued"))]);
  assert.ok(results.every((result) => result.status === "rejected"));
  const recovered = await worker.compute(input("normal"));
  assert.notEqual(recovered.pid, initial.pid);
  await assert.rejects(worker.compute(input("stall")), /worker timed out/);
  assert.notEqual((await worker.compute(input("normal"))).pid, recovered.pid);
  assert.equal((await getRiskEvaluation({ aid: 42, mode: "seasonal", cycleId: "s1" })).evaluatedAt, 789);
});

test("the production image includes the risk worker entry point", () => {
  const dockerfile = readFileSync("Dockerfile", "utf8");
  assert.match(dockerfile, /COPY .*\/app\/scripts\/compute-risk-worker\.mjs \.\/scripts\/compute-risk-worker\.mjs/);
});
