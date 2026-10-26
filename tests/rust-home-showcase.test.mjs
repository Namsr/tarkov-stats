import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { rustBackendBinary, startRustBackend } from "./fixtures/rust-seasonal-http.mjs";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier.startsWith("@/")) return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
    try { return nextResolve(specifier, context); } catch (error) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});
const { GET } = await import("../app/api/home/showcase/route.ts");
const { createShowcaseStore } = await import("../lib/admin/showcase-db.ts");
const configured = { NODE_ENV: "test", SEASONAL_ENABLED: "true", SEASONAL_CYCLE_ID: "cycle-home",
  SEASONAL_STARTS_AT: "2020-01-01", SEASONAL_ENDS_AT: "", SEASONAL_COLLECTION_SOURCE: "operator",
  SEASONAL_UPSTREAM_CONTRACT: "direct_profile", SEASONAL_PROFILE_URL_TEMPLATE: "https://players.tarkov.dev/pvp-season/{aid}.json" };
const fallback = { groupId: null, groupName: null, mode: "regular", aids: [], items: [], seasonalCycleId: null, updatedAt: null };
const publicCache = "public, max-age=30, s-maxage=60";

test("native home showcase preserves the real TS route and recovers after a read lock", { timeout: 30000 }, async (t) => {
  assert.ok(existsSync(rustBackendBinary()));
  const directory = mkdtempSync(join(tmpdir(), "rust-home-showcase-"));
  const servers = [];
  const keys = [...Object.keys(configured), "ADMIN_ANALYTICS_SQLITE_PATH"];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, configured);
  t.after(async () => {
    for (const instance of servers) await instance.stop();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("rust-home-showcase-"));
    // The real TS singleton owns an open connection until this test process exits.
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* Windows live-handle cleanup must not hide assertions. */ }
  });
  async function backend(name, env = {}) {
    const path = join(directory, name, "analytics.db");
    process.env.ADMIN_ANALYTICS_SQLITE_PATH = path;
    const instance = await startRustBackend({ ...configured, ADMIN_ANALYTICS_SQLITE_PATH: path, ...env });
    servers.push(instance);
    return { ...instance, path };
  }
  async function native(instance, path = "/api/home/showcase", options = {}) {
    return fetch(`${instance.base}${path}`, { signal: AbortSignal.timeout(5000), ...options });
  }
  async function parity(instance, context = "") {
    const actual = await native(instance, "/api/home/showcase?ignored=1&mode=invalid&mode=pve");
    const expected = await GET();
    assert.equal(actual.status, 200, context);
    const actualBody = await actual.json();
    assert.deepEqual(actualBody, await expected.json(), context);
    for (const response of [actual, expected]) {
      assert.equal(response.headers.get("cache-control"), publicCache, context);
      assert.equal(response.headers.get("set-cookie"), null);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
    }
    assert.match(actual.headers.get("content-type"), /application\/json/);
    return actualBody;
  }
  const main = await backend("main");
  await t.test("missing databases initialize and empty initialized config retains the ready cycle", async () => {
    const response = await native(main);
    assert.deepEqual(await response.json(), { ...fallback, seasonalCycleId: "cycle-home" });
    assert.ok(existsSync(main.path));
    await parity(main, "empty");
  });
  const db = new DatabaseSync(main.path);
  t.after(() => db.close());
  const store = createShowcaseStore(db);
  await t.test("all modes preserve active selection, item order, disabled filtering and live admin updates", async () => {
    const first = store.createGroup("Main <group>", "regular");
    store.addItem(first.id, 202, "Second"); store.addItem(first.id, 101, "First"); store.addItem(first.id, 303);
    store.updateItem(first.id, 303, { enabled: false }); store.reorder(first.id, [101, 202, 303]);
    for (const mode of ["regular", "pve", "arena", "seasonal"]) {
      store.setGroupMode(first.id, mode); await parity(main, mode);
    }
    const next = store.createGroup("Next", "arena"); store.addItem(next.id, 404); store.setActive(next.id);
    await parity(main, "new active group");
    // Corrupt legacy mode falls back to Regular, matching the existing store.
    db.prepare("UPDATE home_showcase_groups SET mode='unknown' WHERE id=?").run(next.id);
    await parity(main, "unknown mode");
    db.exec("UPDATE home_showcase_groups SET is_active=1");
    await parity(main, "lowest active group wins");
  });
  await t.test("unsafe SQLite integers fail safely instead of publishing rounded player identities", async () => {
    const id = db.prepare("SELECT id FROM home_showcase_groups WHERE is_active=1 ORDER BY id LIMIT 1").get().id;
    db.prepare("INSERT INTO home_showcase_items(group_id,aid,sort,enabled,added_at)VALUES(?,?,0,1,1)").run(id, 9007199254740993n);
    try { assert.deepEqual(await parity(main, "unsafe item AID"), fallback); }
    finally { db.prepare("DELETE FROM home_showcase_items WHERE aid=?").run(9007199254740993n); }
    db.prepare("UPDATE home_showcase_groups SET created_at=? WHERE id=?").run(-9007199254740993n, id);
    try { assert.deepEqual(await parity(main, "unsafe unused group field"), fallback); }
    finally { db.prepare("UPDATE home_showcase_groups SET created_at=1 WHERE id=?").run(id); }
    await parity(main, "unsafe data repaired");
  });
  await t.test("an exclusive read lock returns bounded safe public fallback and next request recovers", async () => {
    db.exec("BEGIN EXCLUSIVE");
    try {
      const result = await native(main);
      assert.equal(result.headers.get("cache-control"), publicCache);
      assert.deepEqual(await result.json(), fallback);
      const health = await fetch(`${main.base}/healthz`, { signal: AbortSignal.timeout(1000) });
      assert.equal(health.status, 200); await health.body?.cancel();
    } finally { db.exec("ROLLBACK"); }
    await parity(main, "lock cleared");
  });
  await t.test("HEAD, OPTIONS, method errors and trailing redirects retain the complete HTTP contract", async () => {
    const head = await native(main, "/api/home/showcase", { method: "HEAD" });
    assert.equal(head.status, 200); assert.equal(await head.text(), ""); assert.equal(head.headers.get("cache-control"), publicCache);
    const options = await native(main, "/api/home/showcase", { method: "OPTIONS" });
    assert.equal(options.status, 204); assert.equal(options.headers.get("allow"), "GET, HEAD, OPTIONS");
    const post = await native(main, "/api/home/showcase", { method: "POST" });
    assert.equal(post.status, 405); assert.equal(post.headers.get("allow"), null);
    assert.equal(post.headers.get("x-content-type-options"), "nosniff");
    const redirect = await native(main, "/api/home/showcase/?x=1", { redirect: "manual" });
    assert.equal(redirect.status, 308); assert.equal(redirect.headers.get("location"), "/api/home/showcase?x=1");
    assert.equal(await redirect.text(), "/api/home/showcase?x=1");
    assert.equal(redirect.headers.get("x-content-type-options"), null);
  });
  await t.test("legacy schema gains only its mode column and preserves records", async () => {
    const legacy = await backend("legacy"); mkdirSync(dirname(legacy.path), { recursive: true });
    const old = new DatabaseSync(legacy.path);
    old.exec(`CREATE TABLE home_showcase_groups(id INTEGER PRIMARY KEY,name TEXT,is_active INTEGER,created_at INTEGER,updated_at INTEGER);
      CREATE TABLE home_showcase_items(group_id INTEGER,aid INTEGER,sort INTEGER,enabled INTEGER,nickname TEXT,added_at INTEGER);
      INSERT INTO home_showcase_groups VALUES(1,'Legacy',1,1000,2000);
      INSERT INTO home_showcase_items VALUES(1,77,0,1,'Old player',1000);`);
    old.close();
    const response = await native(legacy);
    assert.equal((await response.json()).aids[0], 77);
    await parity(legacy, "legacy");
  });
  await t.test("disabled Seasonal configuration does not change configured Arena mode", async () => {
    const disabled = await backend("disabled", { SEASONAL_ENABLED: "false" });
    process.env.SEASONAL_ENABLED = "false";
    await native(disabled); // Initialize before adding a group through the existing admin store.
    const local = new DatabaseSync(disabled.path);
    try { const configuredStore = createShowcaseStore(local); const group = configuredStore.createGroup("Arena", "arena"); configuredStore.addItem(group.id, 88); }
    finally { local.close(); }
    await parity(disabled, "disabled Seasonal");
    process.env.SEASONAL_ENABLED = "true";
  });
  await t.test("unavailable files return the same cacheable fallback and do not expose a ready cycle", async () => {
    const unavailable = await backend("unavailable"); mkdirSync(dirname(unavailable.path), { recursive: true });
    writeFileSync(unavailable.path, "not a sqlite database");
    await parity(unavailable, "bad DB"); await parity(unavailable, "initialization backoff");
  });

});
