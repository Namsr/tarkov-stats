import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const shim = (name) => ({ shortCircuit: true, url: pathToFileURL(resolve(`tests/fixtures/${name}`)).href });

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/operator-auth") return shim("operator-auth-shim.mjs");
    if (specifier === "next/cache") return shim("next-cache-shim.mjs");
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
    }
    // The store opens the database from `process.env` and lazily imports
    // `./storage` without an extension, which the ESM resolver will not guess
    // and which only Next's compiler resolves. Without this the store never
    // loads and every assertion below would pass on a 503 for an unrelated
    // reason, so mirror the extension the bundler adds.
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[cm]?[jt]s$/.test(specifier)) {
      const parent = context.parentURL ? dirname(fileURLToPath(context.parentURL)) : process.cwd();
      for (const extension of [".ts", ".tsx", ".mjs"]) {
        const candidate = resolve(parent, `${specifier}${extension}`);
        if (existsSync(candidate)) return { shortCircuit: true, url: pathToFileURL(candidate).href };
      }
    }
    return nextResolve(specifier, context);
  },
});

const { createSqliteSeasonalOperatorStore } = await import("../lib/seasonal/operator.ts");
const { createSqliteSeasonalStore, initializeSeasonalSchema } = await import("../lib/seasonal/storage.ts");
const { DatabaseSync } = await import("node:sqlite");
const { POST: postRun } = await import("../app/api/operator/seasonal/run/route.ts");
const { POST: postBan } = await import("../app/api/operator/seasonal/ban/route.ts");

const ACTIVE_CYCLE = "cycle-a";
const RETIRED_CYCLE = "cycle-b";
const OWNER = "runner-a";
const LEASE_MS = 5 * 60_000;

const directory = await mkdtemp(join(tmpdir(), "seasonal-run-outcome-"));
process.env.PROGRESSION_SQLITE_PATH = join(directory, "progression.db");
// The route caches the store's own database handle for the process, and Windows
// refuses to unlink a file that is still open, so a leftover temp directory is
// the best this can do here.
test.after(async () => {
  db.close();
  try { await rm(directory, { recursive: true, force: true }); } catch { /* The route keeps its adapter open. */ }
});

Object.assign(process.env, {
  SEASONAL_CYCLE_ID: ACTIVE_CYCLE,
  SEASONAL_STARTS_AT: "2020-01-01T00:00:00Z",
  SEASONAL_UPSTREAM_CONTRACT: "game_mode",
  SEASONAL_ENABLED: "true",
  SEASONAL_PROFILE_URL_TEMPLATE: "https://players.tarkov.dev/{mode}/{aid}.json",
  SEASONAL_COLLECTION_SOURCE: "operator",
});

// The route reads the real store out of `process.env`, so seed the same file it
// opens: a run per cycle with one leased Seasonal task, all through the real
// store API rather than hand-written rows.
const db = new DatabaseSync(process.env.PROGRESSION_SQLITE_PATH);
initializeSeasonalSchema(db);
const queue = createSqliteSeasonalStore(db);
const operator = createSqliteSeasonalOperatorStore(db);
const now = Date.now();

async function leasedTask(cycleId, aid, at) {
  await queue.enqueueTask({ mode: "seasonal", cycleId, aid, kind: "profile", priority: 1, now: at });
  const run = operator.beginOrResumeRun(cycleId, OWNER, at);
  const { task } = operator.claimNext(run.id, OWNER, at);
  return { runId: run.id, taskId: task.id };
}

const fresh = await leasedTask(ACTIVE_CYCLE, 1, now);
const expired = await leasedTask(ACTIVE_CYCLE, 2, now - LEASE_MS - 1_000);
const retired = await leasedTask(RETIRED_CYCLE, 3, now);

const outcome = (body) => postRun(new Request("http://localhost/api/operator/seasonal/run", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ action: "outcome", owner: OWNER, ...body }),
}));

const ban = (body) => postBan(new Request("http://localhost/api/operator/seasonal/ban", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ evidence: "tarkov_dev_name_search_absence", owner: OWNER, ...body }),
}));

async function banTask(aid, at = Date.now(), withProfile = true) {
  const cycleId = `ban-test-${aid}`;
  if (withProfile) db.prepare(`INSERT INTO player_profiles (
    mode, cycle_id, aid, nickname, profile_updated_at, last_access_at,
    experience, pmc_raids, scav_raids, pmc_survived, pmc_deaths, pmc_kills, killed_pmc,
    first_seen_at, last_seen_at
  ) VALUES ('seasonal', ?, ?, 'Test', 1, 1, 0, 1, 0, 0, 1, 0, 0, 1, 1)`).run(cycleId, aid);
  await queue.enqueueTask({ mode: "seasonal", cycleId, aid, kind: "ban_check", priority: 1, now: at });
  const run = operator.beginOrResumeRun(cycleId, OWNER, at);
  const { task } = operator.claimNext(run.id, OWNER, at);
  return { runId: run.id, taskId: task.id, aid, cycleId };
}

test("Seasonal ban confirmation rejects nonpositive IDs and blank identifiers", async () => {
  const valid = { runId: 1, taskId: 1, aid: 1, cycleId: ACTIVE_CYCLE };
  for (const field of ["runId", "taskId", "aid"]) {
    for (const value of [0, -1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal((await ban({ ...valid, [field]: value })).status, 400);
    }
  }
  for (const field of ["owner", "cycleId"]) {
    for (const value of ["", "   "]) assert.equal((await ban({ ...valid, [field]: value })).status, 400);
  }
});

test("Seasonal ban confirmation preserves lease and missing-profile conflicts", async () => {
  assert.equal((await ban(await banTask(101, Date.now() - LEASE_MS - 1_000))).status, 409);
  assert.equal((await ban({ ...await banTask(102), owner: "other" })).status, 409);
  assert.equal((await ban(await banTask(103, Date.now(), false))).status, 409);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM upstream_ban_confirmations").get().n, 0);
});

test("Seasonal ban confirmation reports storage errors as 503 and rolls back", async (t) => {
  const input = await banTask(104);
  db.exec(`CREATE TRIGGER fail_ban_update BEFORE UPDATE ON player_profiles WHEN OLD.aid = 104
    BEGIN SELECT RAISE(ABORT, 'forced storage failure'); END`);
  t.after(() => db.exec("DROP TRIGGER fail_ban_update"));
  t.mock.method(console, "error", () => {});
  const response = await ban(input);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(db.prepare("SELECT confirmed_banned FROM player_profiles WHERE aid = 104").get().confirmed_banned, 0);
});

test("Seasonal ban confirmation persists a valid leased ban check", async () => {
  assert.equal((await ban(await banTask(105))).status, 200);
  assert.equal(db.prepare("SELECT confirmed_banned FROM player_profiles WHERE aid = 105").get().confirmed_banned, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM upstream_ban_confirmations WHERE aid = 105").get().n, 1);
});

// The store throws before it writes anything, so a lapsed lease used to reach
// the route's generic catch and answer a 503 outage. It is a conflict.
test("the operator seasonal run route reports an expired lease as a 409", async () => {
  const response = await outcome({ ...expired, outcome: "completed" });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "Active Seasonal lease not found" });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("the operator seasonal run route reports a run with no live lease as a 409", async () => {
  const response = await outcome({ runId: 999_999, taskId: 999_999, outcome: "completed" });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "Active Seasonal lease not found" });
});

// `recordOutcome` caps the detail at 500 characters, which the request check
// above only guards for type, so an over-long detail is a bad request.
test("the operator seasonal run route rejects an over-long outcome detail with a 400", async () => {
  const response = await outcome({ ...fresh, outcome: "upstream_error", detail: "x".repeat(501) });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "outcome detail is too long" });
});

// `claim` pins the cycle but `outcome` did not, so a retired cycle's run could
// still be completed while another cycle is live.
test("the operator seasonal run route refuses an outcome in a retired cycle", async () => {
  const response = await outcome({ ...retired, outcome: "completed" });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "Active Seasonal lease not found" });
});

test("the operator seasonal run route still records a live lease and rejects a bad outcome", async () => {
  const ok = await outcome({ ...fresh, outcome: "completed" });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { stopped: false, exitCode: 0, consecutiveErrors: 0 });

  const bad = await outcome({ ...fresh, outcome: "nonsense" });
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: "Invalid outcome" });
});
