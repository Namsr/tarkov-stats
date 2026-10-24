import sharp from "sharp";
import { AXIS_PHOTO_MAX_BODY, AXIS_PHOTO_MAX_BYTES, AxisPhotoInputError } from "../lib/axis-match-photo.ts";
import { normalizeAxisPhoto, readAxisPhotoBody } from "../lib/axis-photo-upload.ts";
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
  if (specifier === "@/lib/axis-access") return mockModule("export async function requireAxisKdaEditor() { return globalThis.axisKdaAccess ?? globalThis.axisAccess; } export async function requireAxisScreenshotSubmitter() { return globalThis.axisKdaAccess ?? globalThis.axisAccess; } export async function requireAxisModerator() { return globalThis.axisKdaAccess ?? globalThis.axisAccess; }");
  if (specifier === "@/lib/server-axis-ocr") return mockModule("export async function recognizeAxisPhoto() { if (globalThis.axisOcrFailure) throw new Error('ocr unavailable'); return globalThis.axisOcrResult; } export async function recognizeAxisPhotoUpload(value) { if (globalThis.axisOcrFailure) throw new Error('ocr unavailable'); return { photo: await globalThis.axisNormalizePhoto(value), result: globalThis.axisOcrResult }; }");
  if (specifier === "@/lib/arena/service") return mockModule("export async function getArenaProfile() { return null; }");
  if (specifier === "@/lib/admin/axis-league-db" || specifier === "./admin/axis-league-db.ts") return mockModule("export async function getAxisLeagueStore() { return globalThis.axisStore; }");
  if (specifier === "@/lib/axis-league-sync") return mockModule("export async function loadAxisLeague() { if(globalThis.axisReadError) throw new Error('offline'); return globalThis.axisStore.read(); }");
  if (specifier === "@/lib/axis-history-sync") return mockModule("export async function loadAxisHistory(page) { if(globalThis.axisReadError) throw new Error('offline'); return globalThis.axisStore.readHistory(page); } export async function loadAxisSeasonHistory(page,season,_defer,matchNumber,map) { return matchNumber == null ? globalThis.axisStore.readSeasonHistory(page,season,undefined,map) : globalThis.axisStore.readMatchHistory(matchNumber); }");
  if (specifier.startsWith("@/")) return { shortCircuit: true, url: pathToFileURL(resolve(specifier.slice(2) + ".ts")).href };
  return nextResolve(specifier, context);
} });
const { GET, POST } = await import("../app/api/admin/axis-league/route.ts");
const { GET: publicGet } = await import("../app/api/axis-league/route.ts");
const { GET: historyGet } = await import("../app/api/axis-league/history/route.ts");
const { GET: playerGet } = await import("../app/api/axis-league/player/route.ts");
const { GET: photoGet } = await import("../app/api/axis-league/match-photo/route.ts");
const { POST: statsPost } = await import("../app/api/admin/axis-league/match-stats/route.ts");
const { GET: editorsGet, POST: editorsPost } = await import("../app/api/admin/axis-league/editors/route.ts");
const { POST: profilesPost } = await import("../app/api/axis-league/profiles/route.ts");
const { loadAxisLeague: loadSavedLeague } = await import("../lib/axis-league-sync.ts");
const { loadAxisHistory: loadSavedHistory, loadAxisSeasonHistory: loadSavedSeason } = await import("../lib/axis-history-sync.ts");

const id = "95520357670191104";
const ocrRows = () => Array.from({ length: 10 }, (_, index) => ({
  id: `${index < 5 ? "left" : "right"}:${index % 5}`,
  side: index < 5 ? "left" : "right",
  index: index % 5,
  nickname: index === 0 ? "Player" : `Player ${index + 1}`,
  kills: null, deaths: null, assists: null,
  numberConfidence: { kills: null, deaths: null, assists: null }, confidence: 1,
}));
function setup(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  globalThis.axisAccess = { ok: true, user: { sub: "admin" } };
  globalThis.axisKdaAccess = null;
  globalThis.axisReadError = false;
  globalThis.axisOcrFailure = false;
  globalThis.axisNormalizePhoto = normalizeAxisPhoto;
  globalThis.axisOcrResult = { score: { left: null, right: null }, scoreConfidence: { left: null, right: null }, crop: { x: 0, y: 0, width: 128, height: 72 }, rows: ocrRows() };
  globalThis.axisStore = createAxisLeagueStore(db);
  globalThis.axisStore.publish([{ id, name: "Player", position: 1, mmr: 1000, peakMmr: 1000,
    games: 1, wins: 1, losses: 0, winrate: 1, streak: 1, peakStreak: 1, profile: null }]);
}

function setupStats(t) {
  setup(t);
  globalThis.axisStore.publishArchive({ page: 1, pages: 1, total: 1, matches: [{ number: 5, time: Date.now(), queueId: "1343726040421367842", queue: "Arena League", maps: [], winner: 0,
    teams: [0, 1].map(teamIndex => ({ name: null, players: Array.from({ length: 5 }, (_, index) => {
      const rosterIndex = teamIndex * 5 + index;
      return { id: rosterIndex === 0 ? id : `axis-player-${rosterIndex + 1}`, name: rosterIndex === 0 ? "Player" : `Player ${rosterIndex + 1}`, mmr: 1000, change: 25, profile: null };
    }) })) }] });
}

test("player profiles read locally and validate identity, season, pagination and result", async t => {
  setupStats(t);
  globalThis.axisStore.setProfile(id, { aid: 12345, mode: "arena" });
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = () => { throw new Error("player requests must not call upstream"); };
  const get = query => playerGet(new Request("https://tarkovstats.ru/api/axis-league/player?" + query));
  const response = await get("aid=12345");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).identity.id, id);
  assert.equal((await get("aid=99999")).status, 404);
  for (const query of ["aid=0", "aid=12345&page=0", "aid=12345&page=100001", "aid=12345&result=draw", "aid=12345&season=bad", "aid=12345&season=match-999"]) {
    assert.equal((await get(query)).status, 400, query);
  }
});

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

test("empty archives bootstrap only 25 matches and saved history refreshes after responding", async (t) => {
  setup(t);
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(Number(url.searchParams.get("page_size")));
    assert.equal(url.searchParams.get("page_size"), "25", "HTTP must never import large archive pages");
    return Response.json({ data: Array.from({ length: 25 }, (_, index) => ({ guild_id: "1343726035136413716", game_num: 100 - index,
      time: "2026-10-16 02:00:00", queue_channel: "1343726040421367842", game: "Arena League", winner: 0,
      teams: [[{ id, name: "Player", mmr: 1000, mmr_change: 25 }]], team_names: ["Team A"] })),
      pagination: { current_page: 1, per_page: 25, total_pages: 4, total_items: 100 } });
  };
  const first = await loadSavedSeason(1, "current");
  assert.equal(first.available, true); assert.equal(first.matches.length, 25);
  assert.deepEqual(calls, [25]);
  const deferred = [];
  const saved = await loadSavedSeason(1, "current", task => deferred.push(task));
  assert.equal(saved.available, true); assert.equal(deferred.length, 1);
  assert.deepEqual(calls, [25]);
  // A refresh lease is shared with the worker; it cannot duplicate the bootstrap.
  await deferred[0]();
  assert.deepEqual(calls, [25]);
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
  assert.deepEqual((await (await publicGet()).json()).players[0].combatStats, { ...kda, matches: 1 });
  assert.equal((await statsPost(request({ ...body, players: [{ discordId: id, kda: null, expected: kda }] }))).status, 200);
  assert.equal((await (await publicGet()).json()).players[0].combatStats, null);
});

test("only full admins can manage editors or use admin profile-link endpoints", async (t) => {
  setupStats(t);
  globalThis.axisAccess = { ok: false, status: 403 };
  globalThis.axisKdaAccess = { ok: true, user: { sub: "limited-editor" } };
  assert.equal((await editorsGet()).status, 403);
  assert.equal((await editorsPost(request({ subject: "self", enabled: true }))).status, 403);
  assert.equal((await POST(request({ discordId: id, profile: "12345" }))).status, 403);
  globalThis.axisAccess = { ok: true, user: { sub: "admin" } };
  assert.equal((await editorsPost(request({ subject: "limited-editor", enabled: true }))).status, 200);
  assert.deepEqual((await (await editorsGet()).json()).editors, [{ subject: "limited-editor", name: null, role: "moderator" }]);
  assert.equal(globalThis.axisStore.isKdaEditor("limited-editor"), true);
  assert.equal((await editorsPost(request({ subject: "limited-editor", enabled: false }))).status, 200);
  assert.equal(globalThis.axisStore.isKdaEditor("limited-editor"), false);
  assert.equal((await editorsPost(request({ subject: "<invalid>", enabled: true }))).status, 400);
});
function request(body, headers = {}, path = "/api/admin/axis-league") {
  return new Request("https://tarkovstats.ru" + path, { method: "POST",
    headers: { origin: "https://tarkovstats.ru", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

test("AXIS editors can link, correct and unlink profiles without admin access", async (t) => {
  setupStats(t);
  globalThis.axisAccess = { ok: false, status: 403 };
  const profileRequest = (body, headers = {}) => request(body, headers, "/api/axis-league/profiles");
  const body = { discordId: id, profile: "12345" };
  for (const status of [401, 403]) {
    globalThis.axisKdaAccess = { ok: false, status };
    assert.equal((await profilesPost(profileRequest(body))).status, status);
  }
  globalThis.axisKdaAccess = { ok: true, user: { sub: "limited-editor" } };
  assert.equal((await profilesPost(profileRequest(body, { origin: "https://evil.test" }))).status, 403);
  assert.equal((await profilesPost(profileRequest(body, { "content-type": "text/plain" }))).status, 415);
  for (const invalid of [{ ...body, discordId: "999" }, { ...body, discordId: 123 }, { ...body, profile: "0" }, { ...body, profile: "https://evil.test/player/arena/123" }, { discordId: id }]) {
    assert.equal((await profilesPost(profileRequest(invalid))).status, 400);
  }
  const response = await profilesPost(profileRequest(body));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual((await response.json()).data.players[0].profile, { aid: 12345, mode: "arena" });
  assert.deepEqual(globalThis.axisStore.readSeasonHistory(1, "current").matches[0].teams[0].players[0].profile, { aid: 12345, mode: "arena" });
  assert.equal((await POST(request(body))).status, 403);
  assert.equal((await editorsGet()).status, 403);
  assert.equal((await editorsPost(request({ subject: "self", enabled: true }))).status, 403);
  assert.equal((await profilesPost(profileRequest({ ...body, profile: "/player/regular/54321" }))).status, 200);
  assert.deepEqual(globalThis.axisStore.read().players[0].profile, { aid: 54321, mode: "regular" });
  assert.equal((await profilesPost(profileRequest({ ...body, profile: null }))).status, 200);
  assert.equal(globalThis.axisStore.read().players[0].profile, null);
});

test("editor profile links reject duplicate assignments and fail safely on unavailable storage", async (t) => {
  setup(t);
  const store = globalThis.axisStore;
  store.publish([...store.read().players, { ...store.read().players[0], id: "2", name: "Second" }]);
  store.setProfile("2", { aid: 12345, mode: "arena" });
  globalThis.axisKdaAccess = { ok: true, user: { sub: "limited-editor" } };
  assert.equal((await profilesPost(request({ discordId: id, profile: "12345" }))).status, 400);
  assert.equal(store.read().players[0].profile, null);
  globalThis.axisStore = { setProfile() { throw new Error("offline"); } };
  assert.equal((await profilesPost(request({ discordId: id, profile: "54321" }))).status, 503);
});

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

test("history map filters validate input and remain scoped to the selected season", async t => {
  setup(t);
  const base = { queueId: "1343726040421367842", queue: "Arena League", teams: [], winner: null };
  globalThis.axisStore.publishArchive({ page: 1, pages: 1, total: 3, matches: [
    { ...base, number: 1, time: Date.parse("2026-10-15T22:58:00Z"), maps: ["Bay 5"] },
    { ...base, number: 2, time: Date.now(), maps: ["Bay 5", "Bay 5"] },
    { ...base, number: 3, time: Date.now(), maps: ["Bowl"] },
  ] });
  const get = query => historyGet(new Request("https://tarkovstats.ru/api/axis-league/history?" + query));
  for (const map of ["", " ", "a".repeat(201), "Bay\n5", "\0"]) {
    assert.equal((await get("map=" + encodeURIComponent(map))).status, 400);
  }
  assert.equal((await get("match=2&map=Bay%205")).status, 400);
  const response = await get("season=current&map=Bay%205");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.map, "Bay 5"); assert.equal(body.total, 1);
  assert.deepEqual(body.matches.map(match => match.number), [2]);
  assert.equal((await (await get("map=Bay%205")).json()).total, 2);
  assert.equal((await (await get("season=current&map=" + encodeURIComponent("Bay 5' OR 1=1 --"))).json()).total, 0);
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


test("direct match links read the indexed archive entry and reject invalid or missing numbers", async (t) => {
  setupStats(t);
  const request = (query) => new Request("https://tarkovstats.ru/api/axis-league/history?" + query);
  const response = await historyGet(request("match=5&season=all"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.matchNumber, 5); assert.equal(body.matches[0].number, 5);
  assert.equal(body.season, "all"); assert.equal(body.matches.length, 1);
  assert.equal((await historyGet(request("match=999"))).status, 404);
  for (const query of ["match=0", "match=-1", "match=01", "match=1.5", "match=1000000000", "match=5&page=2", "match=5&season=current"]) {
    assert.equal((await historyGet(request(query))).status, 400, query);
  }
});

const photoPost = statsPost;
const photoRequest = (body, headers = {}) => new Request("https://tarkovstats.ru/api/admin/axis-league/match-stats", {
  method: "POST", headers: { origin: "https://tarkovstats.ru", "content-type": "application/json", ...headers }, body: JSON.stringify(body && { matchNumber: body.matchNumber, players: [], photo: { expected: body.expected, data: body.data } }),
});
const imageFixture = async (color = "#125599") => sharp({ create: { width: 128, height: 72, channels: 3, background: color } }).png().toBuffer();

test("match photos validate access, origin and input, stay independent of stats, and detect simultaneous edits", async t => {
  setupStats(t);
  const data = (await imageFixture()).toString("base64");
  const input = { matchNumber: 5, expected: null, data };
  for (const status of [401, 403]) {
    globalThis.axisKdaAccess = { ok: false, status };
    assert.equal((await photoPost(photoRequest(input))).status, status);
  }
  globalThis.axisAccess = { ok: false, status: 403 };
  globalThis.axisKdaAccess = { ok: true, user: { sub: "limited-editor" } };
  assert.equal((await photoPost(photoRequest(input, { origin: "https://evil.test" }))).status, 403);
  assert.equal((await photoPost(photoRequest(input, { "content-type": "text/plain" }))).status, 415);
  for (const invalid of [null, {}, { ...input, matchNumber: 0 }, { ...input, matchNumber: 999 }, { ...input, expected: "bad" }, { ...input, data: "not base64!" }, { ...input, data: "aGVsbG8=" }]) {
    assert.equal((await photoPost(photoRequest(invalid))).status, 400, JSON.stringify(invalid));
  }
  assert.equal((await photoPost(photoRequest(input, { "content-length": String(AXIS_PHOTO_MAX_BODY + 1) }))).status, 413);
  const response = await photoPost(photoRequest(input));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const saved = (await response.json()).photo;
  assert.equal(saved.width, 128); assert.equal(saved.height, 72); assert.match(saved.revision, /^[a-f0-9]{64}$/);
  assert.equal("data" in saved, false);
  assert.equal((await photoPost(photoRequest(input))).status, 409);
  const history = await (await historyGet(new Request("https://tarkovstats.ru/api/axis-league/history?match=5&season=all"))).json();
  assert.equal(history.matches[0].photo, undefined, "public history must not disclose photo metadata");
  assert.deepEqual(globalThis.axisStore.readMatchPhotoMetadata(5), saved);
  assert.equal(history.matches[0].rounds, null); assert.equal(history.matches[0].teams[0].players[0].kda, null);
  for (const status of [401, 403]) {
    globalThis.axisKdaAccess = { ok: false, status };
    assert.equal((await photoGet(new Request(`https://tarkovstats.ru/api/axis-league/match-photo?match=5&v=${saved.revision}`))).status, status);
    assert.equal((await photoGet(new Request("https://tarkovstats.ru/api/axis-league/match-photo?match=5&meta=1"))).status, status);
  }
  globalThis.axisKdaAccess = { ok: true, user: { sub: "limited-editor" } };
  const metadata = await photoGet(new Request("https://tarkovstats.ru/api/axis-league/match-photo?match=5&meta=1"));
  assert.deepEqual((await metadata.json()).photo, saved);
  const photo = await photoGet(new Request(`https://tarkovstats.ru/api/axis-league/match-photo?match=5&v=${saved.revision}`));
  assert.equal(photo.status, 200); assert.equal(photo.headers.get("content-type"), "image/png");
  assert.equal(photo.headers.get("x-content-type-options"), "nosniff");
  const decoded = await sharp(Buffer.from(await photo.arrayBuffer())).metadata();
  assert.equal(decoded.width, 128); assert.equal(decoded.height, 72);
  assert.equal((await photoGet(new Request("https://tarkovstats.ru/api/axis-league/match-photo?match=5"))).status, 400);
  assert.equal((await photoGet(new Request(`https://tarkovstats.ru/api/axis-league/match-photo?match=6&v=${saved.revision}`))).status, 404);
  // Re-importing the upstream match must retain the locally attached picture.
  globalThis.axisStore.publishArchive({ page: 1, pages: 1, total: 1, matches: history.matches });
  assert.deepEqual(globalThis.axisStore.readMatchPhotoMetadata(5), saved);
  const replacement = { ...input, expected: saved.revision, data: (await imageFixture("#884422")).toString("base64") };
  assert.equal((await photoPost(photoRequest(replacement))).status, 200);
  assert.equal((await photoPost(photoRequest({ ...input, expected: saved.revision, data: null }))).status, 409, "stale deletion cannot remove a replacement");
  assert.equal((await photoGet(new Request(`https://tarkovstats.ru/api/axis-league/match-photo?match=5&v=${saved.revision}`))).status, 200, "submission history keeps both screenshots available to moderators");
  const current = globalThis.axisStore.readMatchPhotoMetadata(5);
  assert.equal((await photoPost(photoRequest({ ...input, expected: current.revision, data: null }))).status, 200);
  assert.equal(globalThis.axisStore.readMatchPhoto(5), null);
});

test("photo uploads decode only static raster images, preserve pixels and orientation, and strip metadata", async () => {
  for (const format of ["jpeg", "webp", "png"]) {
    const data = await sharp({ create: { width: 20, height: 10, channels: 3, background: "red" } })[format]().withMetadata({ orientation: 6 }).toBuffer();
    const photo = await normalizeAxisPhoto(data.toString("base64"));
    assert.equal(photo.width, 10); assert.equal(photo.height, 20);
    const metadata = await sharp(photo.data).metadata();
    assert.equal(metadata.format, "png"); assert.equal(metadata.exif, undefined); assert.equal(metadata.orientation, undefined);
  }
  const original = await imageFixture();
  const normalized = await normalizeAxisPhoto(original.toString("base64"));
  assert.deepEqual(await sharp(normalized.data).raw().toBuffer(), await sharp(original).raw().toBuffer());
  for (const data of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10"/></svg>'),
    await sharp(original).gif().toBuffer(), original.subarray(0, 40)]) {
    await assert.rejects(normalizeAxisPhoto(data.toString("base64")), AxisPhotoInputError);
  }
  await assert.rejects(normalizeAxisPhoto(Buffer.alloc(AXIS_PHOTO_MAX_BYTES + 1).toString("base64")), error => error.status === 413);
  const tooManyPixels = await sharp({ create: { width: 6000, height: 4001, channels: 3, background: "white" } }).png().toBuffer();
  await assert.rejects(normalizeAxisPhoto(tooManyPixels.toString("base64")), AxisPhotoInputError);
  const data = (await imageFixture()).toString("base64");
  assert.equal((await normalizeAxisPhoto(data)).revision, (await normalizeAxisPhoto(data)).revision);
});

test("photo request streaming enforces the byte limit even without Content-Length", async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(AXIS_PHOTO_MAX_BODY)); controller.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } });
  await assert.rejects(readAxisPhotoBody(new Request("http://localhost/", { method: "POST", body: stream, duplex: "half" })), error => error.status === 413);
  assert.equal(cancelled, true);
  assert.deepEqual(await readAxisPhotoBody(new Request("http://localhost/", { method: "POST", body: '{"data":null}' })), { data: null });
});


test("one statistics save commits photo, score and KDA atomically and rolls everything back on conflicts", async t => {
  setupStats(t);
  const data = (await imageFixture()).toString("base64");
  const kda = { kills: 8, deaths: 3, assists: 2 };
  const first = { matchNumber: 5, players: [{ discordId: id, expected: null, kda }], rounds: { expected: null, score: { a: 7, b: 5 } }, photo: { expected: null, data } };
  const saved = await statsPost(request(first)); assert.equal(saved.status, 200);
  const photo = (await saved.json()).photo;
  const nextKda = { kills: 20, deaths: 10, assists: 4 };
  const replacement = (await imageFixture("#aabbcc")).toString("base64");
  const stalePhoto = { ...first, players: [{ discordId: id, expected: kda, kda: nextKda }], rounds: { expected: { a: 7, b: 5 }, score: { a: 8, b: 6 } }, photo: { expected: null, data: replacement } };
  assert.equal((await statsPost(request(stalePhoto))).status, 409);
  let match = globalThis.axisStore.readMatchHistory(5).matches[0];
  assert.deepEqual(match.teams[0].players[0].kda, kda); assert.deepEqual(match.rounds, { a: 7, b: 5 });
  assert.deepEqual(globalThis.axisStore.readMatchPhotoMetadata(5), photo);
  const staleKda = { ...stalePhoto, players: [{ discordId: id, expected: null, kda: nextKda }], photo: { expected: photo.revision, data: replacement } };
  assert.equal((await statsPost(request(staleKda))).status, 409);
  assert.deepEqual(globalThis.axisStore.readMatchPhotoMetadata(5), photo);
  assert.equal((await statsPost(request({ ...stalePhoto, photo: { expected: photo.revision, data: replacement } }))).status, 200);
  match = globalThis.axisStore.readMatchHistory(5).matches[0]; assert.deepEqual(match.teams[0].players[0].kda, nextKda); assert.deepEqual(match.rounds, { a: 8, b: 6 });
  assert.notEqual(globalThis.axisStore.readMatchPhotoMetadata(5).revision, photo.revision);
});


test("Google names resolve IDs before and after granting access without changing editor roles", async t => {
  setupStats(t);
  const { recordGoogleIdentity, googleDisplayName } = await import("../lib/auth/google-identity.ts");
  const account = { sub: "google-editor", name: "  Редактор AXIS  ", email: "private@example.test", picture: "" };
  await recordGoogleIdentity(account);
  assert.equal(globalThis.axisStore.isKdaEditor(account.sub), false);
  // A client-supplied alias is ignored: the directory comes only from verified identities.
  const granted = await editorsPost(request({ subject: account.sub, enabled: true, name: "Forged" }));
  assert.deepEqual((await granted.json()).editors, [{ subject: account.sub, name: "Редактор AXIS", role: "moderator" }]);
  await editorsPost(request({ subject: "pending-editor", enabled: true }));
  let editors = (await (await editorsGet()).json()).editors;
  assert.deepEqual(editors.find(editor => editor.subject === "pending-editor"), { subject: "pending-editor", name: null, role: "moderator" });
  await recordGoogleIdentity({ ...account, sub: "pending-editor" });
  await recordGoogleIdentity({ ...account, name: "New Google name" });
  editors = (await (await editorsGet()).json()).editors;
  assert.equal(editors.find(editor => editor.subject === account.sub).name, "New Google name");
  assert.equal(editors.find(editor => editor.subject === "pending-editor").name, "Редактор AXIS");
  assert.equal(googleDisplayName({ ...account, name: account.email }), null, "never publish Google's email fallback");
  assert.equal(googleDisplayName({ ...account, name: " " }), null);
  globalThis.axisStore = { rememberGoogleAccount() { throw Error("offline"); } };
  await assert.doesNotReject(recordGoogleIdentity(account), "identity persistence must not break sign-in");
});

test("match attribution uses the signed editor, survives refresh and revocation, and keeps private IDs out of public history", async t => {
  setupStats(t);
  const actor = { sub: "real-google-sub", name: "Настоящее имя", email: "private@example.test", picture: "" };
  globalThis.axisKdaAccess = { ok: true, user: actor };
  const score = { a: 7, b: 5 };
  const body = { matchNumber: 5, players: [], rounds: { expected: null, score }, edited: { name: "Forged", at: 1 }, user: { sub: "fake", name: "Forged" } };
  const response = await statsPost(request(body));
  assert.equal(response.status, 200);
  const edit = (await response.json()).edited;
  assert.equal(edit.name, actor.name); assert.ok(edit.at > 1);
  const saved = globalThis.axisStore.readMatchHistory(5).matches[0];
  assert.deepEqual(saved.edited, edit);
  globalThis.axisStore.setKdaEditor(actor.sub, true);
  assert.equal(globalThis.axisStore.listKdaEditors()[0].name, actor.name);
  globalThis.axisStore.setKdaEditor(actor.sub, false);
  globalThis.axisStore.rememberGoogleAccount(actor.sub, "Renamed later");
  globalThis.axisStore.publishArchive({ page: 1, pages: 1, total: 1, matches: [{ ...saved, edited: { name: "Upstream forgery", at: 1 } }] });
  globalThis.axisKdaAccess = { ok: true, user: { ...actor, sub: "another-editor", name: "Another editor" } };
  assert.equal((await statsPost(request(body))).status, 409);
  assert.equal((await statsPost(request({ ...body, rounds: { expected: score, score } }))).status, 200);
  const publicMatch = (await (await historyGet(new Request("https://tarkovstats.ru/api/axis-league/history?match=5&season=all"))).json()).matches[0];
  assert.deepEqual(publicMatch.edited, edit, "conflicts, imports, renames and no-op saves must preserve the last real edit");
  assert.doesNotMatch(JSON.stringify(publicMatch), /real-google-sub|private@example.test|Forged|Upstream forgery/);
  const next = await statsPost(request({ matchNumber: 5, players: [{ discordId: id, expected: null, kda: { kills: 2, deaths: 1, assists: 3 } }] }));
  assert.equal((await next.json()).edited.name, "Another editor");
  const beforePhoto = globalThis.axisStore.readMatchHistory(5).matches[0].edited;
  globalThis.axisKdaAccess = { ok: true, user: { ...actor, name: actor.email } };
  const photo = await statsPost(request({ matchNumber: 5, players: [], photo: { expected: null, data: (await imageFixture()).toString("base64") } }));
  assert.equal(photo.status, 200); assert.equal((await photo.json()).edited.name, null);
  assert.ok(globalThis.axisStore.readMatchHistory(5).matches[0].edited.at >= beforePhoto.at);
});
