import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const dependencies = new Set(["@/lib/auth/session", "@/lib/db", "@/lib/tarkov-api", "@/lib/ban-db", "@/lib/regular-profile-capture", "@/lib/arena/service", "@/lib/progression-db"]);
registerHooks({ resolve(specifier, context, nextResolve) {
  const file = specifier === "next/server" ? "tests/fixtures/favorite-stats-next-shim.mjs"
    : dependencies.has(specifier) ? "tests/fixtures/favorite-stats-shim.mjs"
      : specifier.startsWith("@/") ? `${specifier.slice(2)}.ts` : null;
  return file ? { shortCircuit: true, url: pathToFileURL(resolve(file)).href } : nextResolve(specifier, context);
} });
const { GET } = await import("../app/api/favorites/stats/route.ts");
const { NextRequest } = await import("next/server.js");
const { state } = await import("./fixtures/favorite-stats-shim.mjs");
let ip = 0;
const favorite = (aid, mode = "regular") => ({ aid, mode, cycleId: mode === "seasonal" ? "cycle-one" : "persistent", nickname: "stored-name" });
const stats = (aid, nickname = "fresh-name") => ({ aid, nickname, level: 42, profileUpdatedAt: 1783000000000 });
const call = (force = false) => GET(new NextRequest(`http://localhost/api/favorites/stats${force ? "?refresh=1" : ""}`, { headers: { "x-real-ip": `198.51.100.${++ip}` } }));
function reset(favorites) {
  Object.assign(state, { favorites, snapshots: new Map(), stored: new Map(), arenas: new Map(), calls: [], captures: [], afters: [], levelsCalls: 0, nicknameUpdates: [], user: true, snapshotError: false, levels: undefined, persist: undefined });
  state.fetch = async (aid) => ({ profile: { aid, stats: stats(aid), achievements: { first: 1 } }, fromCache: false });
}

test("favorites load stored Regular snapshots without reference or upstream requests, preserving identities", async () => {
  reset([favorite(1), favorite(1, "pve"), favorite(1, "arena"), favorite(1, "seasonal")]);
  state.snapshots.set("regular:1", { stats: stats(1, "regular") });
  state.stored.set("pve:1", { stats: stats(1, "pve") });
  state.arenas.set(1, { nickname: "arena" });
  const response = await call();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const rows = (await response.json()).favorites;
  assert.equal(state.listSub, "stats-owner");
  assert.deepEqual(rows.map((row) => [row.mode, row.cycleId, row.stats?.nickname ?? row.arena?.nickname ?? null]), [
    ["regular", "persistent", "regular"], ["pve", "persistent", "pve"], ["arena", "persistent", "arena"], ["seasonal", "cycle-one", null],
  ]);
  assert.equal(state.calls.length, 0);
  assert.equal(state.levelsCalls, 0);
});

test("refresh preserves stored data on transient failure, Regular 404 and capture/nickname semantics", async () => {
  reset([favorite(1), favorite(2), favorite(3)]);
  for (const aid of [1, 2, 3]) state.snapshots.set(`regular:${aid}`, { stats: stats(aid, "saved") });
  state.fetch = async (aid, options) => {
    assert.equal(options.force, true);
    assert.ok(options.signal instanceof AbortSignal);
    if (aid === 1) throw new Error("offline");
    return { profile: aid === 2 ? null : { aid, stats: stats(aid), achievements: { first: 1 } }, fromCache: false };
  };
  const rows = (await (await call(true)).json()).favorites;
  assert.deepEqual(rows.map((row) => row.stats?.nickname ?? null), ["saved", null, "fresh-name"]);
  assert.equal(state.captures.length, 1);
  assert.equal(state.captures[0].snapshot.aid, 3);
  assert.deepEqual(state.captures[0].snapshot.achievementIds, ["first"]);
  assert.equal(state.captures[0].options.upsertPlayer, true);
  assert.deepEqual(state.nicknameUpdates[0], ["stats-owner", 3, "fresh-name", { mode: "regular", cycleId: "persistent" }]);
});

test("favorites cap refresh concurrency and cancel waiting fetches at the shared response budget", async (t) => {
  reset(Array.from({ length: 5 }, (_, i) => favorite(i + 1)));
  for (const item of state.favorites) state.snapshots.set(`regular:${item.aid}`, { stats: stats(item.aid, "saved") });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let active = 0;
  let peak = 0;
  state.fetch = async (_aid, { signal }) => {
    active++; peak = Math.max(peak, active);
    try { await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); }
    finally { active--; }
  };
  const waiting = call(true);
  await new Promise(setImmediate);
  assert.equal(state.calls.length, 2);
  t.mock.timers.tick(10_000);
  const rows = (await (await waiting).json()).favorites;
  assert.equal(peak, 2);
  assert.equal(state.calls.length, 2, "deadline must not start later upstream work");
  assert.ok(rows.every((row) => row.stats.nickname === "saved"));
  await Promise.all(state.afters.map((callback) => callback()));
});

test("a held atomic capture cannot hold the response or discard the other saved favorites", async (t) => {
  reset(Array.from({ length: 4 }, (_, i) => favorite(i + 1)));
  for (const item of state.favorites) state.snapshots.set(`regular:${item.aid}`, { stats: stats(item.aid, "saved") });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release;
  let completed = 0;
  const held = new Promise((resolve) => { release = resolve; });
  state.persist = async () => { await held; completed++; };
  const waiting = call(true);
  await new Promise(setImmediate);
  assert.equal(state.captures.length, 2);
  t.mock.timers.tick(10_000);
  const rows = (await (await waiting).json()).favorites;
  assert.deepEqual(rows.map((row) => row.stats.nickname), ["fresh-name", "fresh-name", "saved", "saved"]);
  assert.equal(completed, 0);
  assert.equal(state.afters.length, 1);
  release();
  await Promise.all(state.afters.map((callback) => callback()));
  assert.equal(completed, 2, "already-started captures must finish after the response");
  assert.deepEqual(state.nicknameUpdates.map((update) => update[1]), [1, 2]);
  assert.equal(state.calls.length, 2);
});

test("slow reference levels share one request and cannot keep the response pending", async (t) => {
  reset([favorite(1), favorite(2), favorite(3)]);
  for (const item of state.favorites) state.snapshots.set(`regular:${item.aid}`, { stats: stats(item.aid, "saved") });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release;
  state.levels = () => new Promise((resolve) => { release = resolve; });
  const waiting = call(true);
  await new Promise(setImmediate);
  assert.equal(state.levelsCalls, 1);
  t.mock.timers.tick(10_000);
  assert.ok((await (await waiting).json()).favorites.every((row) => row.stats.nickname === "saved"));
  release([]);
  await Promise.all(state.afters.map((callback) => callback()));
  assert.equal(state.captures.length, 0);
  assert.equal(state.calls.length, 2);
});

test("signed-out favorites remain private and never read profiles", async () => {
  reset([favorite(1)]); state.user = null;
  const response = await call();
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(state.calls.length, 0);
});


test("parsed favorite stats survive synchronous snapshot construction failure", async () => {
  reset([favorite(42)]);
  state.snapshotError = true;
  const rows = (await (await call()).json()).favorites;
  assert.equal(rows[0].stats.nickname, "fresh-name");
  assert.equal(state.captures.length, 0);
  assert.equal(state.nicknameUpdates[0][1], 42);
});
