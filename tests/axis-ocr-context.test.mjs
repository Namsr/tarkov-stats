import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const mockModule = source => ({ shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "@/lib/axis-access") return mockModule("export async function requireAxisKdaEditor() { return globalThis.ocrContextState.access; }");
  if (specifier === "@/lib/admin/mutation") return mockModule("export const ADMIN_NO_STORE_HEADERS = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' };");
  if (specifier === "@/lib/admin/axis-league-db") return mockModule(`export async function getAxisLeagueStore() {
    const state = globalThis.ocrContextState;
    if (state.storeError) throw new Error("store unavailable");
    return { readMatchHistory(number) {
      state.readMatchNumbers.push(number);
      return { matches: state.match?.number === number ? [state.match] : [] };
    } };
  }`);
  if (specifier === "@/lib/arena/service") return mockModule(`export async function getArenaProfile(aid) {
    const state = globalThis.ocrContextState;
    state.profileCalls.push(aid);
    if (state.profileErrors.has(aid)) throw new Error("stored profile unavailable");
    return state.profiles.get(aid) ?? null;
  }`);
  if (specifier.startsWith("@/")) return { shortCircuit: true, url: pathToFileURL(resolve(specifier.slice(2) + ".ts")).href };
  return nextResolve(specifier, context);
} });

const { GET } = await import("../app/api/admin/axis-league/ocr-context/route.ts");

function makeMatch(number = 12) {
  return {
    number,
    winner: 0,
    rounds: { a: 7, b: 4 },
    teams: Array.from({ length: 2 }, (_, teamIndex) => ({
      name: `Team ${teamIndex}`,
      players: Array.from({ length: 5 }, (_, index) => ({
        id: `discord-${teamIndex * 5 + index}`,
        name: `History ${teamIndex * 5 + index}`,
        kda: { kills: 1, deaths: 2, assists: 3 },
        profile: null,
      })),
    })),
  };
}

function setup(t, match = makeMatch()) {
  globalThis.ocrContextState = {
    access: { ok: true, user: { sub: "editor" } },
    match,
    readMatchNumbers: [],
    profileCalls: [],
    profiles: new Map(),
    profileErrors: new Set(),
    storeError: false,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("OCR context must not call upstream"); };
  t.after(() => { globalThis.fetch = originalFetch; });
}

const get = (query = "") => GET(new Request(`https://tarkovstats.ru/api/admin/axis-league/ocr-context${query}`));

test("OCR context checks editor access before reading stored match data", async t => {
  setup(t);
  for (const status of [401, 403]) {
    globalThis.ocrContextState.access = { ok: false, status };
    const response = await get("?match=12");
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(globalThis.ocrContextState.readMatchNumbers.length, 0);
    assert.equal(globalThis.ocrContextState.profileCalls.length, 0);
  }
});

test("OCR context validates the same bounded match number format and reports missing stored matches", async t => {
  setup(t);
  for (const query of ["", "?match=", "?match=0", "?match=1000000000", "?match=1.5", "?match=12&match=13"]) {
    assert.equal((await get(query)).status, 400, query);
  }
  assert.deepEqual(globalThis.ocrContextState.readMatchNumbers, []);
  assert.equal((await get("?match=99")).status, 404);
  assert.deepEqual(globalThis.ocrContextState.readMatchNumbers, [99]);
  assert.deepEqual(globalThis.ocrContextState.profileCalls, []);
});

test("OCR context returns only a bounded roster and deduplicates stored Arena nickname reads", async t => {
  setup(t);
  const state = globalThis.ocrContextState;
  const players = state.match.teams.flatMap(team => team.players);
  players[0].profile = { aid: 700, mode: "arena" };
  players[1].profile = { aid: 700, mode: "arena" };
  players[2].profile = { aid: 701, mode: "arena" };
  players[3].profile = { aid: 702, mode: "arena" };
  players[4].profile = { aid: 703, mode: "arena" };
  players[5].profile = { aid: 704, mode: "regular" };
  state.profiles.set(700, { nickname: "Arena Hero" });
  state.profiles.set(701, { nickname: " Unknown " });
  state.profiles.set(702, null);
  state.profiles.set(704, { nickname: "Stored Arena Name" });
  state.profileErrors.add(703);
  let upstreamCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (...args) => { upstreamCalls++; return originalFetch(...args); };
  t.after(() => { globalThis.fetch = originalFetch; });

  const response = await get("?match=12");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(Object.keys(await response.clone().json()).sort(), ["matchNumber", "participants"]);
  const context = await response.json();
  assert.deepEqual(Object.keys(context), ["matchNumber", "participants"]);
  assert.equal(context.matchNumber, 12);
  assert.equal(context.participants.length, 10);
  assert.deepEqual(context.participants[0], {
    discordId: "discord-0", teamIndex: 0, historyName: "History 0", arenaNickname: "Arena Hero",
  });
  assert.equal(context.participants[1].arenaNickname, "Arena Hero");
  assert.equal(context.participants[2].arenaNickname, null, "Unknown nicknames are omitted");
  assert.equal(context.participants[3].arenaNickname, null, "Missing stored profiles do not remove the player");
  assert.equal(context.participants[4].arenaNickname, null, "A failed stored nickname read does not fail the roster");
  assert.equal(context.participants[5].arenaNickname, "Stored Arena Name", "the linked AID always supplies its stored Arena nickname");
  assert.ok(context.participants.every(participant => Object.keys(participant).sort().join(",") === "arenaNickname,discordId,historyName,teamIndex"));
  assert.deepEqual(state.readMatchNumbers, [12]);
  assert.deepEqual(state.profileCalls, [700, 701, 702, 703, 704]);
  assert.equal(upstreamCalls, 0);
});

test("OCR context rejects rosters that are not exactly two teams of five", async t => {
  const wrongTeamSize = makeMatch(12);
  wrongTeamSize.teams[0].players.pop();
  setup(t, wrongTeamSize);
  assert.equal((await get("?match=12")).status, 422);
  assert.deepEqual(globalThis.ocrContextState.profileCalls, []);

  const repeatedPlayer = makeMatch(12);
  repeatedPlayer.teams[1].players[0].id = repeatedPlayer.teams[0].players[0].id;
  setup(t, repeatedPlayer);
  assert.equal((await get("?match=12")).status, 422);
});

test("OCR context turns store failures into uncached service errors", async t => {
  setup(t);
  globalThis.ocrContextState.storeError = true;
  const response = await get("?match=12");
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: "ocr_context_unavailable" });
});


test("the same match reads a corrected profile link and its latest stored Arena nickname on every request", async t => {
  setup(t);
  const state = globalThis.ocrContextState, player = state.match.teams[0].players[0];
  player.profile = { aid: 700, mode: "arena" };
  state.profiles.set(700, { nickname: "WrongProfile" });
  assert.equal((await (await get("?match=12")).json()).participants[0].arenaNickname, "WrongProfile");
  player.profile = { aid: 701, mode: "arena" };
  assert.equal((await (await get("?match=12")).json()).participants[0].arenaNickname, null,
    "linking an account does not invent a nickname before its Arena snapshot exists");
  state.profiles.set(701, { nickname: "CorrectProfile" });
  assert.equal((await (await get("?match=12")).json()).participants[0].arenaNickname, "CorrectProfile");
  state.profiles.set(701, { nickname: "RenamedProfile" });
  assert.equal((await (await get("?match=12")).json()).participants[0].arenaNickname, "RenamedProfile");
  assert.deepEqual(state.profileCalls, [700, 701, 701, 701]);
});
