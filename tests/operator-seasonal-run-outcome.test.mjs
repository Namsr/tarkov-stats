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
