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
  assert.match(response.headers.get("cache-control"), /max-age=30/);
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
