import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AXIS_SERVER_ID, AXIS_CHANNEL_ID, AXIS_REFRESH_MS, parseAxisPage, parseAxisProfile, axisProfileHref, sortAxisPlayers } from "../lib/axis-league.ts";
import { createAxisLeagueStore } from "../lib/admin/axis-league-db.ts";
import { fetchAxisPlayers, refreshAxisLeague } from "../lib/axis-league-sync.ts";
import { AXIS_HISTORY_PAGE_SIZE, parseAxisHistory } from "../lib/axis-history.ts";
import { fetchAxisHistory, refreshAxisHistory } from "../lib/axis-history-sync.ts";

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

function historyMatch(number = 25) {
  return { guild_id: AXIS_SERVER_ID, game_num: number, game: "Arena League", time: "2026-10-02 23:36:08", winner: 1,
    teams: [[{ id: row().id, name: "Old name", mmr: 1100, mmr_change: -25 }], [{ id: "432141502412750859", name: "Winner", mmr: 1000, mmr_change: 25 }]],
    team_names: ["Team A", "Team B"], matchdata: [["Map", ["Fort"], "https://example.test/private-image"]] };
}
function historyPage(pageNumber = 1, total = 25) {
  return { data: Array.from({ length: Math.max(0, Math.min(25, total - (pageNumber - 1) * 25)) }, (_, i) => historyMatch(total - (pageNumber - 1) * 25 - i)),
    pagination: { current_page: pageNumber, per_page: AXIS_HISTORY_PAGE_SIZE, total_pages: Math.ceil(total / 25), total_items: total } };
}

test("history retains exact player identity, interprets UTC, and strips unrelated metadata", () => {
  const data = parseAxisHistory(historyPage(), 1);
  assert.equal(data.matches[0].time, Date.UTC(2026, 9, 2, 23, 36, 8));
  assert.equal(data.matches[0].teams[0].players[0].id, row().id);
  assert.equal(data.matches[0].teams[0].players[0].change, -25);
  assert.deepEqual(data.matches[0].maps, ["Fort"]);
  assert.equal(JSON.stringify(data).includes("private-image"), false);
  assert.equal(parseAxisHistory(historyPage(2, 26), 2).matches.length, 1);
  assert.equal(parseAxisHistory(historyPage(1, 0), 1).matches.length, 0);
  assert.equal(parseAxisHistory(historyPage(5, 26), 5).matches.length, 0);
});

test("history accepts cancelled, drawn, missing results and hidden ratings", () => {
  const body = historyPage();
  body.data[0] = { ...historyMatch(), time: null, winner: null, teams: [], game: null, matchdata: null };
  body.data[1].winner = -1;
  body.data[2].winner = -2;
  body.data[3].show_mmr = false;
  body.data[3].teams[0][0].mmr = "hidden";
  const data = parseAxisHistory(body, 1);
  assert.deepEqual(data.matches.slice(0, 3).map((match) => match.winner), [null, -1, -2]);
  assert.equal(data.matches[0].time, null);
  assert.equal(data.matches[3].teams[0].players[0].mmr, null);
  assert.equal(data.matches[3].teams[0].players[0].change, null);
});

test("malformed or incomplete history cannot replace a saved page", () => {
  for (const corrupt of [
    (body) => body.data.pop(),
    (body) => body.data[0].guild_id = "other",
    (body) => body.data[0].teams[0][0].id = Number(row().id),
    (body) => body.data[0].time = "nonsense",
    (body) => body.data[0].winner = 2,
    (body) => body.data[0].game_num = body.data[1].game_num,
    (body) => body.pagination.current_page = 2,
    (body) => body.pagination.total_items = 27,
  ]) {
    const body = historyPage(); corrupt(body);
    assert.throws(() => parseAxisHistory(body, 1), TypeError);
  }
});

test("history fetch uses a fixed server, bounded page size and newest-first order", async () => {
  await fetchAxisHistory(2, async (url, options) => {
    assert.equal(url.origin, "https://api.neatqueue.com");
    assert.equal(url.pathname, `/api/v1/history/${AXIS_SERVER_ID}`);
    assert.equal(url.searchParams.get("page"), "2");
    assert.equal(url.searchParams.get("page_size"), "25");
    assert.equal(url.searchParams.get("order"), "desc");
    assert.equal(options.cache, "no-store");
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json(historyPage(2, 26));
  });
  await assert.rejects(fetchAxisHistory(1, async () => new Response(null, { status: 429 })), /429/);
});

test("history snapshots use current admin links even after a player leaves the standings", (t) => {
  const db = store(t);
  db.publish(parseAxisPage(page()).players);
  db.setProfile(row().id, { aid: 12345, mode: "arena" });
  db.publishHistory(parseAxisHistory(historyPage(), 1), 1000);
  db.publish([]);
  const read = db.readHistory(1, 1000);
  assert.equal(read.matches[0].teams[0].players[0].name, "Old name");
  assert.deepEqual(read.matches[0].teams[0].players[0].profile, { aid: 12345, mode: "arena" });
  assert.equal(read.stale, false);
  assert.equal(db.readHistory(1, 1000 + AXIS_REFRESH_MS * 2 + 1).stale, true);
});

test("history refreshes deduplicate by page and keep the last good data on failure", async (t) => {
  const db = store(t);
  let calls = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const request = async (url) => { calls++; await gate; return Response.json(historyPage(Number(url.searchParams.get("page")), 26)); };
  const first = refreshAxisHistory(db, 1, request, AXIS_REFRESH_MS);
  const duplicate = refreshAxisHistory(db, 1, request, AXIS_REFRESH_MS);
  const secondPage = refreshAxisHistory(db, 2, request, AXIS_REFRESH_MS);
  assert.equal(calls, 2);
  release(); await Promise.all([first, duplicate, secondPage]);
  assert.equal(db.readHistory(1).matches.length, 25);
  assert.equal(db.readHistory(2).matches.length, 1);
  await refreshAxisHistory(db, 1, async () => { throw new Error("offline"); }, AXIS_REFRESH_MS * 2);
  assert.equal(db.readHistory(1).available, true);
  assert.equal(db.readHistory(1).stale, true);
  assert.equal(db.readHistory(1).matches.length, 25);
  await refreshAxisHistory(db, 1, async () => Response.json(historyPage(1, 0)), AXIS_REFRESH_MS * 3);
  assert.equal(db.readHistory(1).matches.length, 0);
  assert.equal(db.readHistory(1).stale, false);
});

test("history five-minute leases coordinate separate SQLite store handles", (t) => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const one = createAxisLeagueStore(db), two = createAxisLeagueStore(db);
  assert.equal(one.claimHistoryRefresh(1, AXIS_REFRESH_MS), true);
  assert.equal(two.claimHistoryRefresh(1, AXIS_REFRESH_MS + 1), false);
  assert.equal(two.claimHistoryRefresh(2, AXIS_REFRESH_MS + 1), true);
  assert.equal(two.claimHistoryRefresh(1, AXIS_REFRESH_MS * 2), true);
  assert.equal(one.claimRefresh(AXIS_REFRESH_MS), true);
});

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
