import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier === "next/cache") {
      return { shortCircuit: true, url: pathToFileURL(resolve("tests/fixtures/next-cache-shim.mjs")).href };
    }
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
    }
    try { return nextResolve(specifier, context); } catch (error) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const { GET } = await import("../app/api/support/route.ts");
const { createSupportStore } = await import("../lib/admin/support-db.ts");

function tempDb(t, seed) {
  const directory = mkdtempSync(join(tmpdir(), "support-api-"));
  const path = join(directory, "nested", "support.db");
  mkdirSync(join(directory, "nested"), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000;");
  seed(createSupportStore(db));
  db.close();
  // Best-effort cleanup: Windows may keep the WAL/SHM handles for a moment.
  t.after(() => {
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  return path;
}

function withEnv(t, values) {
  const keys = Object.keys(values);
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

async function readJson(response) {
  assert.equal(response.status, 200);
  return response.json();
}

const PUBLIC_CACHE_POLICY = "public, max-age=30, s-maxage=60";

/** Assert the exact policy, not a substring: a fallback that shipped no
 *  Cache-Control at all also satisfies `/max-age/`, which is how it survived. */
function assertPublicCachePolicy(response) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), PUBLIC_CACHE_POLICY);
}

test("support content returns only live notifications and the active goal", async (t) => {
  const path = tempDb(t, (store) => {
    store.createNotification({ title: "Live", body: "Shown", level: "warn", href: "/about" });
    const hidden = store.createNotification({ title: "Hidden", body: "Not shown" });
    store.setNotificationActive(hidden.id, false);
    store.createGoal({ collectedRub: 4200, goalRub: 10000, usdRate: 95 });
  });
  withEnv(t, { ADMIN_ANALYTICS_SQLITE_PATH: path });

  const response = await GET();
  const body = await readJson(response);
  assert.deepEqual(body.notifications.map((item) => item.title), ["Live"]);
  assert.equal(body.notifications[0].href, "/about");
  assert.equal(body.notifications[0].level, "warn");
  assert.equal(body.goal.collectedRub, 4200);
  assert.equal(body.goal.goalRub, 10000);
  assert.equal(body.goal.usdRate, 95);
  assertPublicCachePolicy(response);
});

test("support content is empty when nothing is live, so the block draws nothing", async (t) => {
  const path = tempDb(t, (store) => {
    const notice = store.createNotification({ title: "Draft", body: "Hidden" });
    store.setNotificationActive(notice.id, false);
    const goal = store.createGoal({ collectedRub: 0, goalRub: 5000, usdRate: 95 });
    store.deleteGoal(goal.id);
  });
  withEnv(t, { ADMIN_ANALYTICS_SQLITE_PATH: path });

  const response = await GET();
  assert.deepEqual(await readJson(response), { notifications: [], goal: null });
  assertPublicCachePolicy(response);
});

test("support content returns the safe empty fallback when the store cannot open", async (t) => {
  withEnv(t, { ADMIN_ANALYTICS_SQLITE_PATH: "\\\\invalid\\path\\support.db" });
  assert.deepEqual(await readJson(await GET()), { notifications: [], goal: null });
});

test("support content gives the fallback the same public cache policy as the live config", async (t) => {
  // Initialization mkdirs the parent directory, and package.json is a tracked
  // file that is always present, so the mkdir fails with EEXIST. That fails fast
  // and does not depend on a local-only directory such as ops/ existing.
  withEnv(t, { ADMIN_ANALYTICS_SQLITE_PATH: "package.json/support.db" });

  const unavailable = await GET();
  assert.deepEqual(await readJson(unavailable), { notifications: [], goal: null });
  assertPublicCachePolicy(unavailable);
  // The failed initialization armed a five-second backoff, so the store is skipped
  // entirely. Different trigger, same fallback, same policy.
  const backingOff = await GET();
  assert.deepEqual(await readJson(backingOff), { notifications: [], goal: null });
  assertPublicCachePolicy(backingOff);
});
