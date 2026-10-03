import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AXIS_SERVER_ID, AXIS_CHANNEL_ID, AXIS_REFRESH_MS, parseAxisPage, parseAxisProfile, axisProfileHref, sortAxisPlayers } from "../lib/axis-league.ts";
import { createAxisLeagueStore } from "../lib/admin/axis-league-db.ts";
import { fetchAxisPlayers, refreshAxisLeague } from "../lib/axis-league-sync.ts";

function row(id = "95520357670191104", name = "Player") {
  return { id, name, stats: { current_rank: 1, mmr: 1425, peak_mmr: 1500, totalgames: 29, wins: 23, losses: 6, winrate: 23 / 29, streak: -2, peak_streak: 6 } };
}
function page(rows = [row()], total = rows.length, pages = 1) {
  return { server_id: AXIS_SERVER_ID, channel_id: AXIS_CHANNEL_ID, display: "players",
    months: [{ month: "alltime", data: rows, pagination: { total_items: total, total_pages: pages } }] };
}
function store(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  return createAxisLeagueStore(db);
}

test("parses exact Discord IDs and signed streaks, rejecting malformed upstream data", () => {
  const parsed = parseAxisPage(page()).players[0];
  assert.equal(parsed.id, "95520357670191104");
  assert.equal(parsed.streak, -2);
  assert.equal(parsed.winrate, 23 / 29);
  for (const corrupt of [
    { ...page(), server_id: "other" }, { ...page(), display: "parties" },
    page([{ ...row(), id: 95520357670191104 }]), page([{ ...row(), name: "" }]),
    page([{ ...row(), stats: { ...row().stats, mmr: "1425" } }]),
    page([{ ...row(), stats: { ...row().stats, winrate: 79.3 } }]),
  ]) assert.throws(() => parseAxisPage(corrupt), TypeError);
});

test("profile input accepts IDs and canonical profile links, preserving their game mode", () => {
  assert.deepEqual(parseAxisProfile(" 12345 "), { aid: 12345, mode: "arena" });
  assert.deepEqual(parseAxisProfile("https://tarkov.dev/players/regular/12345?x=1"), { aid: 12345, mode: "regular" });
  assert.deepEqual(parseAxisProfile("https://tarkovstats.ru/player/pvp-season/12345"), { aid: 12345, mode: "seasonal" });
  assert.deepEqual(parseAxisProfile("/player/arena/12345"), { aid: 12345, mode: "arena" });
  assert.equal(axisProfileHref({ aid: 12345, mode: "seasonal" }), "/player/pvp-season/12345");
  for (const input of ["0", "-1", "1.5", "99999999999999999", "javascript:alert(1)", "https://evil.test/player/arena/12345", "https://tarkov.dev.evil.test/players/arena/12345", "/player/arena/12345/extra", "https://user@tarkovstats.ru/player/arena/12345"]) {
    assert.equal(parseAxisProfile(input), null, input);
  }
});

test("stats sync preserves manual profile links across renames, absences and store reopen", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const first = createAxisLeagueStore(db);
  const players = parseAxisPage(page()).players;
  first.publish(players, 1000);
  first.setProfile(players[0].id, { aid: 12345, mode: "arena" });
  first.publish([], 2000);
  first.publish([{ ...players[0], name: "Renamed", mmr: 2000 }], 3000);
  const reopened = createAxisLeagueStore(db);
  assert.equal(reopened.read(3000).players[0].name, "Renamed");
  assert.deepEqual(reopened.read(3000).players[0].profile, { aid: 12345, mode: "arena" });
  reopened.setProfile(players[0].id, { aid: 12345, mode: "regular" });
  assert.equal(reopened.read(3000).players[0].profile.mode, "regular");
  reopened.setProfile(players[0].id, null);
  assert.equal(reopened.read(3000).players[0].profile, null);
});

test("duplicate profile links and unknown players cannot overwrite a valid assignment", (t) => {
  const db = store(t);
  const players = parseAxisPage(page([row(), row("432141502412750859", "Second")])).players;
  db.publish(players);
  db.setProfile(players[0].id, { aid: 12345, mode: "arena" });
  assert.throws(() => db.setProfile(players[1].id, { aid: 12345, mode: "arena" }), RangeError);
  assert.throws(() => db.setProfile("1", { aid: 999, mode: "arena" }), RangeError);
  assert.throws(() => db.setProfile(players[0].id, { aid: -1, mode: "arena" }), TypeError);
  assert.equal(db.read().players[0].profile.aid, 12345);
  db.setProfile(players[1].id, { aid: 12345, mode: "regular" });
  assert.equal(db.read().players[1].profile.mode, "regular");
});

test("one refresh claim per five-minute interval across store handles", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const a = createAxisLeagueStore(db), b = createAxisLeagueStore(db);
  assert.equal(a.claimRefresh(AXIS_REFRESH_MS), true);
  assert.equal(b.claimRefresh(AXIS_REFRESH_MS + 1), false);
  assert.equal(b.claimRefresh(AXIS_REFRESH_MS * 2 - 1), false);
  assert.equal(b.claimRefresh(AXIS_REFRESH_MS * 2), true);
});

test("pagination collects all participants and rejects missing, duplicated or changed pages", async () => {
  const a = row(), b = row("432141502412750859", "Second");
  const calls = [];
  const request = async (url) => {
    calls.push(url);
    assert.equal(url.searchParams.get("display"), "players");
    assert.equal(url.searchParams.get("month"), "alltime");
    return Response.json(page(url.searchParams.get("page") === "1" ? [a] : [b], 2, 2));
  };
  assert.equal((await fetchAxisPlayers(request)).length, 2);
  assert.equal(calls.length, 2);
  await assert.rejects(fetchAxisPlayers(async () => Response.json(page([a], 2, 1))), /Incomplete/);
  await assert.rejects(fetchAxisPlayers(async () => Response.json(page([a], 2, 2))), /Incomplete/);
  await assert.rejects(fetchAxisPlayers(async (url) => Response.json(page([a], url.searchParams.get("page") === "1" ? 2 : 3, 2))), /changed/);
  await assert.rejects(fetchAxisPlayers(async () => new Response("down", { status: 429 })), /HTTP 429/);
});

test("concurrent requests await the same refresh rather than returning an empty snapshot", async (t) => {
  const db = store(t);
  let finish;
  const response = new Promise((resolve) => { finish = resolve; });
  let calls = 0;
  const request = async () => { calls++; return response; };
  const first = refreshAxisLeague(db, request, AXIS_REFRESH_MS);
  const second = refreshAxisLeague(db, request, AXIS_REFRESH_MS);
  assert.equal(calls, 1);
  finish(Response.json(page()));
  await Promise.all([first, second]);
  assert.equal(db.read().available, true);
});

test("failed or malformed refresh keeps the last snapshot and links, then recovers", async (t) => {
  const db = store(t);
  const players = parseAxisPage(page()).players;
  db.publish(players, AXIS_REFRESH_MS);
  db.setProfile(players[0].id, { aid: 12345, mode: "arena" });
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = warn; });
  let calls = 0;
  await refreshAxisLeague(db, async () => { calls++; throw new Error("offline"); }, AXIS_REFRESH_MS * 2);
  assert.equal(db.read(AXIS_REFRESH_MS * 2).stale, true);
  assert.equal(db.read().players[0].mmr, 1425);
  assert.equal(db.read().players[0].profile.aid, 12345);
  await refreshAxisLeague(db, async () => { calls++; return Response.json(page()); }, AXIS_REFRESH_MS * 2 + 1);
  assert.equal(calls, 1);
  await refreshAxisLeague(db, async () => Response.json(page([{ ...row(), stats: { ...row().stats, mmr: 1500 } }])), AXIS_REFRESH_MS * 3);
  assert.equal(db.read().stale, false);
  assert.equal(db.read().players[0].mmr, 1500);
  assert.equal(db.read().players[0].profile.aid, 12345);
});

test("sorting keeps the upstream place, uses stable ties and puts unavailable stats last", () => {
  const a = parseAxisPage(page()).players[0];
  const players = [a, { ...a, id: "2", position: 2, peakMmr: null, mmr: 1000 }, { ...a, id: "3", position: 3 }];
  assert.deepEqual(sortAxisPlayers(players, "mmr", "asc").map((p) => p.position), [2, 1, 3]);
  assert.deepEqual(sortAxisPlayers(players, "peakMmr", "desc").map((p) => p.position), [1, 3, 2]);
  assert.deepEqual(sortAxisPlayers(players, "peakMmr", "asc").map((p) => p.position), [1, 3, 2]);
  assert.deepEqual(players.map((p) => p.position), [1, 2, 3]);
});
