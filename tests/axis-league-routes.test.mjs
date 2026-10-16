import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createAxisLeagueStore } from "../lib/admin/axis-league-db.ts";

const mockModule = (source) => ({ shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "next/server") return mockModule("export function after() {};");
  if (specifier === "@/lib/admin-auth") return mockModule("export async function requireAdmin() { return globalThis.axisAccess; }");
  if (specifier === "@/lib/axis-access") return mockModule("export async function requireAxisKdaEditor() { return globalThis.axisKdaAccess ?? globalThis.axisAccess; }");
  if (specifier === "@/lib/admin/axis-league-db" || specifier === "./admin/axis-league-db.ts") return mockModule("export async function getAxisLeagueStore() { return globalThis.axisStore; }");
  if (specifier === "@/lib/axis-league-sync") return mockModule("export async function loadAxisLeague() { if(globalThis.axisReadError) throw new Error('offline'); return globalThis.axisStore.read(); }");
  if (specifier === "@/lib/axis-history-sync") return mockModule("export async function loadAxisHistory(page) { if(globalThis.axisReadError) throw new Error('offline'); return globalThis.axisStore.readHistory(page); } export async function loadAxisSeasonHistory(page,season) { return globalThis.axisStore.readSeasonHistory(page,season); }");
  if (specifier.startsWith("@/")) return { shortCircuit: true, url: pathToFileURL(resolve(specifier.slice(2) + ".ts")).href };
  return nextResolve(specifier, context);
} });
const { GET, POST } = await import("../app/api/admin/axis-league/route.ts");
const { GET: publicGet } = await import("../app/api/axis-league/route.ts");
const { GET: historyGet } = await import("../app/api/axis-league/history/route.ts");
const { POST: statsPost } = await import("../app/api/admin/axis-league/match-stats/route.ts");
const { GET: editorsGet, POST: editorsPost } = await import("../app/api/admin/axis-league/editors/route.ts");
const { loadAxisLeague: loadSavedLeague } = await import("../lib/axis-league-sync.ts");
const { loadAxisHistory: loadSavedHistory, loadAxisSeasonHistory: loadSavedSeason } = await import("../lib/axis-history-sync.ts");

const id = "95520357670191104";
function setup(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  globalThis.axisAccess = { ok: true, user: { sub: "admin" } };
  globalThis.axisKdaAccess = null;
  globalThis.axisReadError = false;
  globalThis.axisStore = createAxisLeagueStore(db);
  globalThis.axisStore.publish([{ id, name: "Player", position: 1, mmr: 1000, peakMmr: 1000,
    games: 1, wins: 1, losses: 0, winrate: 1, streak: 1, peakStreak: 1, profile: null }]);
}

function setupStats(t) {
  setup(t);
  globalThis.axisStore.publishArchive({ page: 1, pages: 1, total: 1, matches: [{ number: 5, time: Date.now(), queueId: "1343726040421367842", queue: "Arena League", maps: [], winner: 0,
    teams: [{ name: null, players: [{ id, name: "Player", mmr: 1000, change: 25, profile: null }] }, { name: null, players: [] }] }] });
}

test("saved standings return before a blocked upstream refresh; both history URLs stay local", async (t) => {
  setupStats(t);
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let calls = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async () => { calls++; await gate; throw new Error("offline"); };
  const deferred = [];
  const saved = await loadSavedLeague((task) => deferred.push(task));
  assert.equal(saved.available, true); assert.equal(calls, 0); assert.equal(deferred.length, 1);
  const pending = deferred[0]();
  assert.equal(calls, 1);
  assert.equal((await loadSavedLeague()).available, true);
  assert.equal((await loadSavedHistory(1)).matches[0].number, 5);
  assert.equal((await loadSavedSeason(1, "current")).matches[0].number, 5);
  assert.equal(calls, 1);
  release(); await pending;
  assert.equal((await loadSavedLeague()).available, true);
});

test("editors can save round scores without changing player KDA", async (t) => {
  setupStats(t);
  globalThis.axisAccess = { ok: false, status: 403 };
  globalThis.axisKdaAccess = { ok: true, user: { sub: "limited-editor" } };
  const body = { matchNumber: 5, players: [], rounds: { score: { a: 7, b: 5 }, expected: null } };
  const response = await statsPost(request(body));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).rounds, { a: 7, b: 5 });
  assert.equal((await statsPost(request(body))).status, 409);
  const read = await historyGet(new Request("https://tarkovstats.ru/api/axis-league/history?season=current"));
  assert.deepEqual((await read.json()).matches[0].rounds, { a: 7, b: 5 });
});

test("KDA writes validate access, origin, roster and counters, and detect lost updates", async (t) => {
  setupStats(t);
  const kda = { kills: 8, deaths: 2, assists: 4 };
  const body = { matchNumber: 5, players: [{ discordId: id, kda, expected: null }] };
  for (const status of [401, 403]) {
    globalThis.axisKdaAccess = { ok: false, status };
    assert.equal((await statsPost(request(body))).status, status);
  }
  globalThis.axisKdaAccess = { ok: true, user: { sub: "limited-editor" } };
  assert.equal((await statsPost(request(body, { origin: "https://evil.test" }))).status, 403);
  assert.equal((await statsPost(request(body, { "content-type": "text/plain" }))).status, 415);
  assert.equal((await statsPost(request({ ...body, matchNumber: 999 }))).status, 400);
  assert.equal((await statsPost(request({ ...body, players: [{ ...body.players[0], discordId: "999" }] }))).status, 400);
  assert.equal((await statsPost(request({ ...body, players: [{ ...body.players[0], kda: { ...kda, kills: -1 } }] }))).status, 400);
  const response = await statsPost(request(body));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await statsPost(request(body))).status, 409);
  assert.deepEqual(globalThis.axisStore.readSeasonHistory(1, "current").matches[0].teams[0].players[0].kda, kda);
  assert.equal((await statsPost(request({ ...body, players: [{ discordId: id, kda: null, expected: kda }] }))).status, 200);
});

test("only full admins can list, assign or revoke KDA editors or change profile links", async (t) => {
  setupStats(t);
  globalThis.axisAccess = { ok: false, status: 403 };
  globalThis.axisKdaAccess = { ok: true, user: { sub: "limited-editor" } };
  assert.equal((await editorsGet()).status, 403);
  assert.equal((await editorsPost(request({ subject: "self", enabled: true }))).status, 403);
  assert.equal((await POST(request({ discordId: id, profile: "12345" }))).status, 403);
  globalThis.axisAccess = { ok: true, user: { sub: "admin" } };
  assert.equal((await editorsPost(request({ subject: "limited-editor", enabled: true }))).status, 200);
  assert.deepEqual((await (await editorsGet()).json()).editors, ["limited-editor"]);
  assert.equal(globalThis.axisStore.isKdaEditor("limited-editor"), true);
  assert.equal((await editorsPost(request({ subject: "limited-editor", enabled: false }))).status, 200);
  assert.equal(globalThis.axisStore.isKdaEditor("limited-editor"), false);
  assert.equal((await editorsPost(request({ subject: "<invalid>", enabled: true }))).status, 400);
});
function request(body, headers = {}) {
  return new Request("https://tarkovstats.ru/api/admin/axis-league", { method: "POST",
    headers: { origin: "https://tarkovstats.ru", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

test("public history validates pages and returns saved data with current profile links", async (t) => {
  setup(t);
  for (const page of ["0", "-1", "1.5", "100001", "Infinity", "1x", ""]) {
    const response = await historyGet(new Request(`https://tarkovstats.ru/api/axis-league/history?page=${page}`));
    assert.equal(response.status, 400);
  }
  assert.equal((await historyGet(new Request("https://tarkovstats.ru/api/axis-league/history"))).status, 503);
  globalThis.axisStore.publishHistory({ page: 1, pages: 1, total: 1, matches: [{ number: 42, time: Date.now(), queue: "Arena League", maps: ["Fort"], winner: 0,
    teams: [{ name: null, players: [{ id, name: "Player", mmr: 1000, change: 25, profile: null }] }] }] });
  globalThis.axisStore.setProfile(id, { aid: 12345, mode: "arena" });
  let response = await historyGet(new Request("https://tarkovstats.ru/api/axis-league/history?page=1"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual((await response.json()).matches[0].teams[0].players[0].profile, { aid: 12345, mode: "arena" });
  globalThis.axisStore.failHistoryRefresh(1);
  response = await historyGet(new Request("https://tarkovstats.ru/api/axis-league/history?page=1"));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).stale, true);
  globalThis.axisStore.setProfile(id, null);
  assert.equal((await (await historyGet(new Request("https://tarkovstats.ru/api/axis-league/history"))).json()).matches[0].teams[0].players[0].profile, null);
  globalThis.axisReadError = true;
  assert.equal((await historyGet(new Request("https://tarkovstats.ru/api/axis-league/history"))).status, 503);
});

test("admin reads and writes require a session and admin identity", async (t) => {
  setup(t);
  for (const status of [401, 403]) {
    globalThis.axisAccess = { ok: false, status };
    assert.equal((await GET()).status, status);
    assert.equal((await POST(request({ discordId: id, profile: "12345" }))).status, status);
    assert.equal(globalThis.axisStore.read().players[0].profile, null);
  }
});

test("season API validates selectors and returns only the requested local season", async (t) => {
  setup(t);
  for (const season of ["", "../file", "match-0", "unknown"]) {
    assert.equal((await historyGet(new Request(`https://tarkovstats.ru/api/axis-league/history?season=${season}`))).status, 400);
  }
  assert.equal((await historyGet(new Request("https://tarkovstats.ru/api/axis-league/history?season=match-999"))).status, 400);
  globalThis.axisStore.publishArchive({ page: 1, pages: 1, total: 1, matches: [{ number: 5, time: Date.now(), queueId: "1343726040421367842", queue: "Arena League", maps: [], teams: [], winner: null }] });
  const response = await historyGet(new Request("https://tarkovstats.ru/api/axis-league/history?season=current"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.season, "current"); assert.equal(body.total, 1);
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
