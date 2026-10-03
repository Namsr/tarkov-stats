import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createAxisLeagueStore } from "../lib/admin/axis-league-db.ts";

const mockModule = (source) => ({ shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "@/lib/admin-auth") return mockModule("export async function requireAdmin() { return globalThis.axisAccess; }");
  if (specifier === "@/lib/admin/axis-league-db") return mockModule("export async function getAxisLeagueStore() { return globalThis.axisStore; }");
  if (specifier === "@/lib/axis-league-sync") return mockModule("export async function loadAxisLeague() { if(globalThis.axisReadError) throw new Error('offline'); return globalThis.axisStore.read(); }");
  if (specifier.startsWith("@/")) return { shortCircuit: true, url: pathToFileURL(resolve(specifier.slice(2) + ".ts")).href };
  return nextResolve(specifier, context);
} });
const { GET, POST } = await import("../app/api/admin/axis-league/route.ts");
const { GET: publicGet } = await import("../app/api/axis-league/route.ts");

const id = "95520357670191104";
function setup(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  globalThis.axisAccess = { ok: true, user: { sub: "admin" } };
  globalThis.axisReadError = false;
  globalThis.axisStore = createAxisLeagueStore(db);
  globalThis.axisStore.publish([{ id, name: "Player", position: 1, mmr: 1000, peakMmr: 1000,
    games: 1, wins: 1, losses: 0, winrate: 1, streak: 1, peakStreak: 1, profile: null }]);
}
function request(body, headers = {}) {
  return new Request("https://tarkovstats.ru/api/admin/axis-league", { method: "POST",
    headers: { origin: "https://tarkovstats.ru", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

test("admin reads and writes require a session and admin identity", async (t) => {
  setup(t);
  for (const status of [401, 403]) {
    globalThis.axisAccess = { ok: false, status };
    assert.equal((await GET()).status, status);
    assert.equal((await POST(request({ discordId: id, profile: "12345" }))).status, status);
    assert.equal(globalThis.axisStore.read().players[0].profile, null);
  }
});

test("cross-origin and non-JSON writes are rejected without changing links", async (t) => {
  setup(t);
  assert.equal((await POST(request({ discordId: id, profile: "12345" }, { origin: "https://evil.test" }))).status, 403);
  assert.equal((await POST(request({ discordId: id, profile: "12345" }, { "content-type": "text/plain" }))).status, 415);
  assert.equal(globalThis.axisStore.read().players[0].profile, null);
});

test("saving, changing and unlinking profiles is reflected in the public leaderboard", async (t) => {
  setup(t);
  let response = await POST(request({ discordId: id, profile: "12345" }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  let data = await (await publicGet()).json();
  assert.deepEqual(data.players[0].profile, { aid: 12345, mode: "arena" });
  response = await POST(request({ discordId: id, profile: "https://tarkovstats.ru/player/regular/98765" }));
  assert.equal(response.status, 200);
  data = await (await publicGet()).json();
  assert.deepEqual(data.players[0].profile, { aid: 98765, mode: "regular" });
  assert.equal((await POST(request({ discordId: id, profile: null }))).status, 200);
  assert.equal((await (await publicGet()).json()).players[0].profile, null);
});

test("malformed inputs and unknown participants return 400 and preserve valid links", async (t) => {
  setup(t);
  await POST(request({ discordId: id, profile: "12345" }));
  for (const body of [null, [], { discordId: id, profile: 12345 }, { discordId: Number(id), profile: "12345" },
    { discordId: id, profile: "" }, { discordId: id, profile: "https://evil.test/player/arena/12345" }, { discordId: "1", profile: "45678" }]) {
    assert.equal((await POST(request(body))).status, 400, JSON.stringify(body));
    assert.equal(globalThis.axisStore.read().players[0].profile.aid, 12345);
  }
});

test("public reads serve a stale snapshot; no snapshot returns a retryable error", async (t) => {
  setup(t);
  globalThis.axisStore.failRefresh();
  const response = await publicGet();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).stale, true);
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  globalThis.axisStore = createAxisLeagueStore(db);
  assert.equal((await publicGet()).status, 503);
});
