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

const { GET } = await import("../app/api/home/showcase/route.ts");
const { createShowcaseStore } = await import("../lib/admin/showcase-db.ts");

const SEASONAL_ENV = {
  SEASONAL_ENABLED: "true", SEASONAL_CYCLE_ID: "cycle-42", SEASONAL_STARTS_AT: "2026-01-01",
  SEASONAL_UPSTREAM_CONTRACT: "direct_profile", SEASONAL_UPSTREAM_FIXTURE_CONFIRMED: "true",
  SEASONAL_PROFILE_URL_TEMPLATE: "https://players.tarkov.dev/pvp-season/{aid}.json",
};

function tempDb(t, seed) {
  const directory = mkdtempSync(join(tmpdir(), "showcase-api-"));
  const path = join(directory, "nested", "showcase.db");
  mkdirSync(join(directory, "nested"), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000;");
  const store = createShowcaseStore(db);
  seed(store);
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

test("home showcase returns the active group mode and the current seasonal cycle", async (t) => {
  const path = tempDb(t, (store) => {
    const group = store.createGroup("Main", "pve");
    store.addItem(group.id, 101, "Player");
    store.setActive(group.id);
  });
  withEnv(t, { ADMIN_ANALYTICS_SQLITE_PATH: path, ...SEASONAL_ENV });

  const response = await GET();
  const body = await readJson(response);
  assert.equal(body.mode, "pve");
  assert.equal(body.seasonalCycleId, "cycle-42");
  assert.deepEqual(body.aids, [101]);
  assert.match(String(body.updatedAt), /^\d+$/);
  // Held to the same exact value as the fallback, so the two paths cannot drift
  // apart. A substring match is what let the fallback ship with no policy.
  assertPublicCachePolicy(response);
});

test("home showcase keeps the configured mode when the seasonal rollout is off", async (t) => {
  const path = tempDb(t, (store) => {
    const group = store.createGroup("Main", "arena");
    store.addItem(group.id, 202);
    store.setActive(group.id);
  });
  withEnv(t, { ADMIN_ANALYTICS_SQLITE_PATH: path, SEASONAL_ENABLED: "false", SEASONAL_CYCLE_ID: "", SEASONAL_PROFILE_URL_TEMPLATE: "" });

  const body = await readJson(await GET());
  assert.equal(body.mode, "arena");
  assert.equal(body.seasonalCycleId, null);
  assert.deepEqual(body.aids, [202]);
});

test("home showcase returns the safe fallback when the store cannot open", async (t) => {
  withEnv(t, { ADMIN_ANALYTICS_SQLITE_PATH: "\\\\invalid\\path\\showcase.db", SEASONAL_ENABLED: "false", SEASONAL_CYCLE_ID: "", SEASONAL_PROFILE_URL_TEMPLATE: "" });
  const body = await readJson(await GET());
  assert.equal(body.groupId, null);
  assert.equal(body.groupName, null);
  assert.equal(body.mode, "regular");
  assert.equal(body.seasonalCycleId, null);
  assert.deepEqual(body.aids, []);
  assert.deepEqual(body.items, []);
  assert.equal(body.updatedAt, null);
});

// The showcase is deliberately public, so no response from this route may be
// left for a shared cache to age on its own heuristics. The fallback used to
// ship with no Cache-Control, which let an edge cache hold an empty showcase
// far past the s-maxage=60 the success path declares. The client's
// `cache: "no-store"` in components/HomePage.tsx bypasses the browser and Next
// caches only, so it does not cover this.
test("home showcase gives the fallback the same public cache policy as the active config", async (t) => {
  // Initialization mkdirs the parent directory, and package.json is a tracked
  // file that is always present, so the mkdir fails with EEXIST. That fails fast
  // and does not depend on a local-only directory such as ops/ existing, which
  // a fresh CI checkout does not have.
  withEnv(t, { ADMIN_ANALYTICS_SQLITE_PATH: "package.json/showcase.db", SEASONAL_ENABLED: "false", SEASONAL_CYCLE_ID: "", SEASONAL_PROFILE_URL_TEMPLATE: "" });

  // First call: the store is missing, so the route answers with the fallback.
  // The body is checked too, so the test proves it reached the fallback rather
  // than silently succeeding and asserting the policy of the happy path.
  const unavailable = await GET();
  assert.deepEqual(await readJson(unavailable), {
    groupId: null, groupName: null, mode: "regular", aids: [], items: [], seasonalCycleId: null, updatedAt: null,
  });
  assertPublicCachePolicy(unavailable);
  // Second call: the failed initialization armed a five-second backoff, so the
  // store is skipped entirely. Different trigger, same fallback, same policy.
  const backingOff = await GET();
  assert.deepEqual(await readJson(backingOff), {
    groupId: null, groupName: null, mode: "regular", aids: [], items: [], seasonalCycleId: null, updatedAt: null,
  });
  assertPublicCachePolicy(backingOff);
});
