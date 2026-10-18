import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { AXIS_SERVER_ID, AXIS_CHANNEL_ID, AXIS_REFRESH_MS, parseAxisPage, parseAxisProfile, axisProfileHref, axisAvatarUrl, sortAxisPlayers, axisKdaRatio, axisMatchHref } from "../lib/axis-league.ts";
import { createAxisLeagueStore } from "../lib/admin/axis-league-db.ts";
import { fetchAxisPlayers, refreshAxisLeague } from "../lib/axis-league-sync.ts";
import { AXIS_HISTORY_PAGE_SIZE, parseAxisHistory, sortAxisMatchPlayers } from "../lib/axis-history.ts";
import { refreshAxisArchive } from "../lib/axis-history-sync.ts";
import { AXIS_CURRENT_SEASON_START, detectAxisSeasons } from "../lib/axis-seasons.ts";
import { axisPlayerHref } from "../lib/axis-player-profile.ts";
import { AxisKdaConflict, parseAxisKdaChanges } from "../lib/axis-kda.ts";

function row(id = "95520357670191104", name = "Player") {
  return { id, name, stats: { current_rank: 1, mmr: 1425, peak_mmr: 1500, totalgames: 29, wins: 23, losses: 6, winrate: 23 / 29, streak: -2, peak_streak: 6 } };
}

test("AXIS previews keep league statistics separate and request Arena regardless of the linked mode", async () => {
  const require = createRequire(import.meta.url);
  const ts = require("typescript");
  const { renderToStaticMarkup } = require("react-dom/server");
  const source = await readFile("components/AxisPlayerIdentity.tsx", "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
  const identityModule = { exports: {} };
  const stubs = {
    "next/image": () => null,
    "@/components/LeaderboardPreview": { LeaderboardPreviewLink: () => null, LeaderboardPreviewProvider: () => null },
    "@/lib/i18n/context": { useI18n: () => ({ lang: "ru", t: (key) => key }) },
    "@/lib/axis-league": { axisProfileHref, axisKdaRatio, axisMatchHref },
    "@/lib/axis-player-profile": { axisPlayerHref },
  };
  new Function("require", "module", "exports", compiled)((name) => stubs[name] ?? require(name), identityModule, identityModule.exports);
  for (const mode of ["regular", "pve", "seasonal", "arena"]) {
    const identity = identityModule.exports.default({ player: { name: "Discord player", profile: { aid: 12345, mode } }, mmr: 1000 });
    assert.deepEqual(identity.props.meta, { mode: "arena", cycleId: null, arenaMode: "blastGang", generation: 0 });
    assert.equal(identity.props.children.props.aid, 12345);
    assert.equal(identity.props.children.props.href, "/player/arena/12345?arenaMode=axis");
    assert.equal(identity.props.detailsLabel, "axis.title");
  }
  const unlinked = identityModule.exports.default({ player: { name: "Discord player", profile: null }, mmr: null });
  assert.equal(unlinked.props.children.props.aid, null);
  assert.equal(unlinked.props.children.props.href, null);
  const player = { name: "Player", profile: null, position: 1, games: 5, wins: 3, losses: 2,
    winrate: .6, peakMmr: 1240, combatStats: { kills: 42, deaths: 0, assists: 8, matches: 3 },
    recentMatches: [{ number: 123, time: 1000, kills: 0, deaths: 0, assists: 0, won: false },
      { number: 124, time: 2000, kills: 12, deaths: 3, assists: 3, won: true }] };
  const filled = identityModule.exports.default({ player, mmr: 1025, averageKda: 2.5 });
  const header = renderToStaticMarkup(filled.props.detailsHeader("preview-name"));
  assert.match(header, /#1/); assert.match(header, /1\s025/); assert.match(header, /1\s240/);
  assert.match(header, /id="preview-name"/);
  const details = renderToStaticMarkup(filled.props.children.props.details);
  assert.match(details, /href="\/axis-league\?view=history&amp;match=123#axis-match-123"/);
  assert.match(details, /data-result="loss"/); assert.match(details, /data-result="win"/);
  assert.match(details, /50,00/); // Zero deaths uses a denominator of one.
  assert.doesNotMatch(details, /HS%|arena.metric.kd_ratio|NaN|undefined|axis.kda.coverage/);
  const empty = identityModule.exports.default({ player: { name: "Player", profile: null, games: 0, winrate: null }, mmr: null });
  assert.match(renderToStaticMarkup(empty.props.children.props.details), /axis.kda.empty/);
  assert.equal(axisKdaRatio({ kills: 0, deaths: 0, assists: 0 }), 0);

});
function page(rows = [row()], total = rows.length, pages = 1) {
  return { server_id: AXIS_SERVER_ID, channel_id: AXIS_CHANNEL_ID, display: "players",
    months: [{ month: "alltime", data: rows, pagination: { total_items: total, total_pages: pages } }] };
}
function store(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  return createAxisLeagueStore(db);
}

test("match players rank by kills, fewer deaths, assists, then nickname without mutating the roster", () => {
  const player = (name, kills, deaths, assists) => ({ id: name, name, kda: { kills, deaths, assists } });
  const players = [
    { id: "missing", name: "Unknown", kda: null },
    player("Zulu", 10, 2, 5), player("Leader", 11, 20, 0),
    player("Bravo", 10, 2, 5), player("Assist", 10, 99, 6),
    player("FewerDeaths", 10, 1, 5), player("Zero", 0, 0, 0), player("MoreAssists", 10, 2, 6),
    { id: "omitted", name: "Absent" },
  ];
  const original = structuredClone(players);
  assert.deepEqual(sortAxisMatchPlayers(players, "en").map(p => p.name),
    ["Leader", "FewerDeaths", "MoreAssists", "Bravo", "Zulu", "Assist", "Zero", "Unknown", "Absent"]);
  assert.deepEqual(players, original);
  assert.deepEqual(sortAxisMatchPlayers(players.filter(p => p.kda == null), "en"), players.filter(p => p.kda == null));
  assert.deepEqual(sortAxisMatchPlayers([player("Яков", 1, 1, 1), player("Антон", 1, 1, 1), player("Борис", 1, 1, 1)], "ru").map(p => p.name),
    ["Антон", "Борис", "Яков"]);
});

test("match 5663 puts fewer deaths ahead of more assists when kills are tied", () => {
  const players = [
    { id: "1", name: "Shcherbak", kda: { kills: 21, deaths: 18, assists: 9 } },
    { id: "2", name: "Lapps_Twitch", kda: { kills: 21, deaths: 12, assists: 7 } },
    { id: "3", name: "W8Power", kda: { kills: 19, deaths: 16, assists: 6 } },
    { id: "4", name: "MSHK_Gummy", kda: { kills: 18, deaths: 16, assists: 7 } },
    { id: "5", name: "BogHblu", kda: { kills: 11, deaths: 17, assists: 7 } },
  ];
  assert.deepEqual(sortAxisMatchPlayers(players, "ru").map(player => player.name),
    ["Lapps_Twitch", "Shcherbak", "W8Power", "MSHK_Gummy", "BogHblu"]);
});

function historyMatch(number = 25) {
  return { guild_id: AXIS_SERVER_ID, game_num: number, game: "Arena League", time: "2026-10-02 23:36:08", winner: 1,
    teams: [[{ id: row().id, name: "Old name", mmr: 1100, mmr_change: -25 }], [{ id: "432141502412750859", name: "Winner", mmr: 1000, mmr_change: 25 }]],
    team_names: ["Team A", "Team B"], matchdata: [["Map", ["Fort"], "https://example.test/private-image"]] };
}
function historyPage(pageNumber = 1, total = 25) {
  return { data: Array.from({ length: Math.max(0, Math.min(25, total - (pageNumber - 1) * 25)) }, (_, i) => historyMatch(total - (pageNumber - 1) * 25 - i)),
    pagination: { current_page: pageNumber, per_page: AXIS_HISTORY_PAGE_SIZE, total_pages: Math.ceil(total / 25), total_items: total } };
}

test("Discord avatars accept only public avatar paths and discard arbitrary destinations", () => {
  const url = `https://cdn.discordapp.com/avatars/${row().id}/abc123.png?size=1024`;
  assert.equal(axisAvatarUrl(url), url.replace("1024", "128"));
  assert.equal(parseAxisPage(page([{ ...row(), avatar_url: url }])).players[0].avatarUrl, axisAvatarUrl(url));
  const body = historyPage(); body.data[0].teams[0][0].avatar_url = url;
  assert.equal(parseAxisHistory(body, 1).matches[0].teams[0].players[0].avatarUrl, axisAvatarUrl(url));
  for (const invalid of ["javascript:alert(1)", "https://evil.test/avatar.png", "https://cdn.discordapp.com/attachments/1/2/image.png", "http://cdn.discordapp.com/embed/avatars/0.png", "https://user@cdn.discordapp.com/embed/avatars/0.png", null]) assert.equal(axisAvatarUrl(invalid), null);
});

function seasonMatch(number, time, mmr = 1100, queueId = AXIS_CHANNEL_ID) {
  return { number, time, queueId, queue: "Arena League", winner: 0, maps: [], teams: [{ name: null,
    players: Array.from({ length: 10 }, (_, i) => ({ id: String(i + 1), name: `Player ${i}`, mmr, change: i < 5 ? 25 : -25, profile: null })) }] };
}

test("manual KDA stays with a match and Discord identity across refreshes, renames and reopen", (t) => {
  const sql = new DatabaseSync(":memory:"); t.after(() => sql.close());
  let db = createAxisLeagueStore(sql);
  const match = seasonMatch(100, AXIS_CURRENT_SEASON_START + 1);
  const snapshot = { matches: [match], page: 1, pages: 1, total: 1 };
  db.publishArchive(snapshot); db.publishHistory(snapshot);
  const kda = { kills: 12, deaths: 0, assists: 3 };
  db.setMatchStats(100, [{ discordId: "1", kda, expected: null }]);
  match.teams[0].players[0].name = "Renamed";
  db.publishArchive(snapshot); db.publishHistory(snapshot);
  db = createAxisLeagueStore(sql);
  assert.deepEqual(db.readHistory(1).matches[0].teams[0].players[0].kda, kda);
  assert.deepEqual(db.readSeasonHistory(1, "current").matches[0].teams[0].players[0].kda, kda);
  assert.equal(db.readSeasonHistory(1, "all").matches[0].teams[0].players[1].kda, null);
  db.setMatchStats(100, [{ discordId: "1", kda: null, expected: kda }]);
  assert.equal(db.readHistory(1).matches[0].teams[0].players[0].kda, null);
  db.setMatchStats(100, [{ discordId: "1", kda: { kills: 0, deaths: 0, assists: 0 }, expected: null }]);
  assert.deepEqual(db.readHistory(1).matches[0].teams[0].players[0].kda, { kills: 0, deaths: 0, assists: 0 });
});

test("standings sum saved KDA across current-season completed matches and track edits by Discord ID", (t) => {
  const sql = new DatabaseSync(":memory:"); t.after(() => sql.close());
  let db = createAxisLeagueStore(sql);
  db.publish(parseAxisPage(page([row("1", "New name"), row("2"), row("3")])).players);
  const matches = Array.from({ length: 29 }, (_, i) => seasonMatch(i + 1, AXIS_CURRENT_SEASON_START + i));
  matches.push(seasonMatch(30, AXIS_CURRENT_SEASON_START - 1),
    seasonMatch(31, AXIS_CURRENT_SEASON_START + 31, 1100, "other"), seasonMatch(32, null));
  matches[27].winner = -1; // Cancelled.
  matches[28].winner = null; // No result.
  const drawn = seasonMatch(33, AXIS_CURRENT_SEASON_START + 33); drawn.winner = -2; matches.push(drawn);
  const snapshot = { page: 1, pages: 2, total: matches.length, matches };
  db.publishArchive(snapshot); db.publishHistory(snapshot);
  const kda = { kills: 12, deaths: 3, assists: 5 }, zero = { kills: 0, deaths: 0, assists: 0 };
  const second = { kills: 8, deaths: 4, assists: 2 };
  for (const [number, stats] of [[1, kda], [2, zero], [27, second], [28, kda], [29, kda], [30, kda], [31, kda], [32, kda], [33, { kills: 3, deaths: 1, assists: 4 }]]) {
    db.setMatchStats(number, [{ discordId: "1", kda: stats, expected: null }]);
  }
  db.setMatchStats(1, [{ discordId: "3", kda: zero, expected: null }]);
  // Reimports and overlapping history pages cannot duplicate saved match totals.
  db.publishArchive(snapshot); db.publishHistory({ ...snapshot, page: 2 });
  db = createAxisLeagueStore(sql);
  const stats = () => db.read().players.find(player => player.id === "1").combatStats;
  assert.deepEqual(stats(), { kills: 23, deaths: 8, assists: 11, matches: 4 });
  assert.deepEqual(db.read().players[0].recentMatches.map(match => match.number), [1, 2, 27, 33]);
  assert.deepEqual(db.read().players[0].recentMatches.map(match => match.won), [true, true, true, null]);
  assert.ok(Math.abs(db.read().averageKda - (17 / 3 + 2.5 + 7) / 5) < 1e-9);
  assert.equal(db.read().players.find(player => player.id === "2").combatStats, null);
  assert.deepEqual(db.read().players.find(player => player.id === "3").combatStats, { ...zero, matches: 1 });
  const edited = { kills: 2, deaths: 1, assists: 0 };
  db.setMatchStats(1, [{ discordId: "1", kda: edited, expected: kda }]);
  assert.deepEqual(stats(), { kills: 13, deaths: 6, assists: 6, matches: 4 });
  db.setMatchStats(27, [{ discordId: "1", kda: null, expected: second }]);
  assert.deepEqual(stats(), { kills: 5, deaths: 2, assists: 4, matches: 3 });
  // Corrected upstream rosters must not attribute stale KDA to a former participant.
  matches[0].teams[0].players = matches[0].teams[0].players.filter(player => player.id !== "1");
  db.publishArchive(snapshot);
  assert.deepEqual(stats(), { kills: 3, deaths: 1, assists: 4, matches: 2 });
});

test("KDA batches reject stale edits atomically and cannot edit people outside a match", (t) => {
  const db = store(t); const match = seasonMatch(1, AXIS_CURRENT_SEASON_START + 1);
  db.publishHistory({ matches: [match], page: 1, pages: 1, total: 1 });
  const kda = { kills: 3, deaths: 1, assists: 2 };
  db.setMatchStats(1, [{ discordId: "1", kda, expected: null }]);
  assert.throws(() => db.setMatchStats(1, [{ discordId: "2", kda, expected: null }, { discordId: "1", kda: null, expected: null }]), AxisKdaConflict);
  assert.equal(db.readHistory(1).matches[0].teams[0].players[1].kda, null);
  assert.throws(() => db.setMatchStats(1, [{ discordId: "999", kda, expected: null }]), RangeError);
  assert.throws(() => db.setMatchStats(99, [{ discordId: "1", kda, expected: null }]), RangeError);
  for (const invalid of [-1, 1.5, 10000, "2", null]) assert.throws(() => parseAxisKdaChanges([{ discordId: "1", kda: { ...kda, deaths: invalid }, expected: null }]), TypeError);
  assert.throws(() => parseAxisKdaChanges([{ discordId: "1", kda }]), TypeError);
  assert.throws(() => parseAxisKdaChanges([{ discordId: "1", kda, expected: null }, { discordId: "1", kda, expected: null }]), TypeError);
});

test("round scores persist with match KDA and stale score updates cannot partially save player stats", (t) => {
  const db = store(t); const match = seasonMatch(55, AXIS_CURRENT_SEASON_START + 1);
  match.teams.push({ name: "Team B", players: [] });
  const snapshot = { matches: [match], page: 1, pages: 1, total: 1 };
  db.publishArchive(snapshot); db.publishHistory(snapshot);
  const kda = { kills: 7, deaths: 3, assists: 2 };
  const score = { a: 7, b: 5 };
  db.setMatchStats(55, [{ discordId: "1", kda, expected: null }], { score, expected: null });
  db.publishArchive(snapshot); db.publishHistory(snapshot);
  assert.deepEqual(db.readSeasonHistory(1, "current").matches[0].rounds, score);
  assert.deepEqual(db.readHistory(1).matches[0].rounds, score);
  assert.throws(() => db.setMatchStats(55, [{ discordId: "2", kda, expected: null }], { score: { a: 1, b: 0 }, expected: null }), AxisKdaConflict);
  assert.equal(db.readHistory(1).matches[0].teams[0].players[1].kda, null);
  for (const a of [-1, 1.5, 10000, "7"]) assert.throws(() => db.setMatchStats(55, [], { score: { a, b: 0 }, expected: score }), TypeError);
  db.setMatchStats(55, [], { score: { a: 0, b: 0 }, expected: score });
  assert.deepEqual(db.readHistory(1).matches[0].rounds, { a: 0, b: 0 });
  db.setMatchStats(55, [], { score: null, expected: { a: 0, b: 0 } });
  assert.equal(db.readHistory(1).matches[0].rounds, null);
  assert.deepEqual(db.readHistory(1).matches[0].teams[0].players[0].kda, kda);
});

test("seasons require a mass returning-player reset and preserve the confirmed Moscow boundary", () => {
  const start = Date.UTC(2026, 8, 1);
  const first = seasonMatch(1, start);
  const ordinary = seasonMatch(2, start + 1000, 1125);
  ordinary.teams[0].players[0].mmr = 1000;
  const reset = seasonMatch(3, start + 2000, 1000);
  const current = seasonMatch(4, AXIS_CURRENT_SEASON_START + 60_000, 1000);
  const seasons = detectAxisSeasons([current, reset, ordinary, first, seasonMatch(5, start + 3000, 1000, "other")]);
  assert.equal(seasons.length, 3);
  assert.equal(seasons[0].startsAt, Date.parse("2026-10-15T22:59:00Z"));
  assert.equal(seasons[0].inferred, false);
  assert.equal(seasons[1].firstMatch, 3);
  assert.equal(seasons[1].inferred, true);
  assert.equal(seasons[2].matches, 2);
  assert.deepEqual(detectAxisSeasons([]).map(s => s.id), ["current"]);
});

test("season pages exclude other queues and unknown times while the full archive retains them", (t) => {
  const db = store(t);
  const matches = Array.from({ length: 26 }, (_, i) => seasonMatch(i + 1, AXIS_CURRENT_SEASON_START + i * 1000));
  matches.push(seasonMatch(27, null), seasonMatch(28, AXIS_CURRENT_SEASON_START, 1000, "other"));
  db.publishArchive({ page: 1, pages: 1, total: matches.length, matches }, 1000);
  const first = db.readSeasonHistory(1, "current", 1000);
  assert.equal(first.total, 26); assert.equal(first.pages, 2); assert.equal(first.matches.length, 25);
  assert.equal(db.readSeasonHistory(2, "current", 1000).matches[0].number, 1);
  assert.equal(db.readSeasonHistory(1, "all", 1000).total, 28);
  assert.equal(first.archiveComplete, true);
  assert.throws(() => db.readSeasonHistory(1, "match-999"), RangeError);
  db.failArchiveRefresh();
  assert.equal(db.readSeasonHistory(1, "current", 1000).stale, true);
  assert.equal(db.readSeasonHistory(1, "current", 1000).total, 26);
});

test("future mass resets create another season without erasing the confirmed boundary", () => {
  const first = seasonMatch(100, AXIS_CURRENT_SEASON_START + 1000, 1000);
  const next = seasonMatch(101, AXIS_CURRENT_SEASON_START + 2000, 1200);
  const reset = seasonMatch(102, AXIS_CURRENT_SEASON_START + 3000, 1000);
  const seasons = detectAxisSeasons([first, next, reset]);
  assert.equal(seasons.length, 2);
  assert.equal(seasons[0].id, "current"); assert.equal(seasons[0].inferred, true);
  assert.equal(seasons[1].startsAt, AXIS_CURRENT_SEASON_START);
  assert.equal(seasons[1].inferred, false);
});

test("persisted season summaries survive reopen, skip unchanged imports and update across store handles", (t) => {
  const sql = new DatabaseSync(":memory:"); t.after(() => sql.close());
  const one = createAxisLeagueStore(sql), two = createAxisLeagueStore(sql);
  const matches = Array.from({ length: 60 }, (_, i) => seasonMatch(i + 1, AXIS_CURRENT_SEASON_START + i));
  const snapshot = { page: 1, pages: 1, total: matches.length, matches };
  one.publishArchive(snapshot, 1000);
  assert.equal(two.readSeasonHistory(3, "current").matches.length, 10);
  const before = sql.prepare("SELECT total_changes() AS n").get().n;
  one.publishArchive(snapshot, 1000);
  assert.equal(sql.prepare("SELECT total_changes() AS n").get().n - before, 1, "unchanged matches and season summaries must not be rewritten");
  matches[59].time = AXIS_CURRENT_SEASON_START - 1;
  one.publishArchive(snapshot, 1000);
  assert.equal(two.readSeasonHistory(1, "current").total, 59);
  assert.equal(two.readSeasonHistory(1, "all").total, 60);
  const reopened = createAxisLeagueStore(sql);
  assert.equal(reopened.readSeasonHistory(1, "current").total, 59);
  // Existing installations build the summary once from their saved archive.
  sql.prepare("UPDATE axis_archive_seasons SET payload=NULL").run();
  assert.equal(reopened.readSeasonHistory(1, "current").total, 59);
  assert.ok(sql.prepare("SELECT payload FROM axis_archive_seasons").get().payload);
});

test("season games count completed AXIS matches once, excluding cancellations and other queues", (t) => {
  const db = store(t);
  assert.equal(db.read().currentSeason.games, null);
  const matches = [seasonMatch(1, AXIS_CURRENT_SEASON_START + 1),
    { ...seasonMatch(2, AXIS_CURRENT_SEASON_START + 2), winner: -2 },
    { ...seasonMatch(3, AXIS_CURRENT_SEASON_START + 3), winner: -1 },
    { ...seasonMatch(4, AXIS_CURRENT_SEASON_START + 4), winner: null },
    seasonMatch(5, AXIS_CURRENT_SEASON_START + 5, 1100, "another-queue"),
    seasonMatch(6, AXIS_CURRENT_SEASON_START - 1)];
  db.publishArchive({ page: 1, pages: 1, total: matches.length, matches });
  assert.equal(db.read().currentSeason.games, 2);
});

test("partial archives do not report an incomplete season count as the full number of games", (t) => {
  const db = store(t);
  const matches = Array.from({ length: 25 }, (_, i) => seasonMatch(100 - i, AXIS_CURRENT_SEASON_START + i));
  db.publishArchive({ page: 1, pages: 4, total: 100, matches });
  assert.equal(db.read().currentSeason.games, null);
  matches.forEach((match, i) => { if (i >= 2) match.time = AXIS_CURRENT_SEASON_START - 1; });
  db.publishArchive({ page: 1, pages: 4, total: 100, matches });
  assert.equal(db.read().currentSeason.games, 2);
});

test("archive refresh imports bounded pages, coordinates store handles and retains data on failure", async (t) => {
  const db = store(t); let calls = 0;
  const request = async url => {
    calls++;
    assert.equal(url.searchParams.get("page_size"), "50");
    const body = historyPage(1, 1); body.pagination.per_page = 50;
    body.data[0].queue_channel = AXIS_CHANNEL_ID;
    return Response.json(body);
  };
  await refreshAxisArchive(db, request, AXIS_REFRESH_MS);
  await refreshAxisArchive(db, request, AXIS_REFRESH_MS + 1);
  assert.equal(calls, 1); assert.equal(db.archiveState().complete, 1);
  await refreshAxisArchive(db, async () => { throw new Error("offline"); }, AXIS_REFRESH_MS * 2);
  assert.equal(db.readSeasonHistory(1, "all").matches.length, 1);
  assert.equal(db.readSeasonHistory(1, "all").stale, true);
});

test("complete archives poll only 25 newest matches and catch up missing matches after an outage", async (t) => {
  const db = store(t);
  db.publishArchive({ page: 1, pages: 1, total: 1, matches: [seasonMatch(1, AXIS_CURRENT_SEASON_START)] });
  const calls = [];
  let total = 1;
  const request = async (url) => {
    const size = Number(url.searchParams.get("page_size"));
    const page = Number(url.searchParams.get("page"));
    calls.push([page, size]);
    return Response.json({ data: Array.from({ length: Math.max(0, Math.min(size, total - (page - 1) * size)) }, (_, i) => historyMatch(total - (page - 1) * size - i)),
      pagination: { current_page: page, per_page: size, total_pages: Math.ceil(total / size), total_items: total } });
  };
  await refreshAxisArchive(db, request, AXIS_REFRESH_MS);
  assert.deepEqual(calls, [[1, 25]]);
  // A saved cursor from an earlier import must not skip a gap after a longer outage.
  db.publishArchive({ page: 7, pages: 20, total: 1, matches: [] });
  total = 127; calls.length = 0;
  await refreshAxisArchive(db, request, AXIS_REFRESH_MS * 2);
  assert.deepEqual(calls, [[1, 25], [1, 50], [2, 50], [3, 50]]);
  assert.equal(db.archiveState().complete, 1);
  assert.equal(db.readSeasonHistory(1, "all").total, 127);
  assert.equal(db.readSeasonHistory(6, "all").matches.at(-1).number, 1);
  calls.length = 0;
  await refreshAxisArchive(db, request, AXIS_REFRESH_MS * 3);
  assert.deepEqual(calls, [[1, 25]]);
});

test("initial archive import stays bounded and resumes the next 50-match page", async (t) => {
  const db = store(t); const calls = [];
  const request = async url => {
    const page = Number(url.searchParams.get("page"));
    const size = Number(url.searchParams.get("page_size"));
    calls.push(page); assert.equal(size, 50);
    return Response.json({ data: Array.from({ length: Math.min(size, 151 - (page - 1) * size) }, (_, i) => historyMatch(151 - (page - 1) * size - i)),
      pagination: { current_page: page, per_page: size, total_pages: 4, total_items: 151 } });
  };
  await refreshAxisArchive(db, request, AXIS_REFRESH_MS);
  assert.deepEqual(calls, [1, 2, 3]); assert.equal(db.archiveState().complete, 0);
  assert.equal(db.readSeasonHistory(1, "all").total, 150);
  calls.length = 0;
  await refreshAxisArchive(db, request, AXIS_REFRESH_MS + 30_000);
  assert.deepEqual(calls, [1, 4]); assert.equal(db.archiveState().complete, 1);
  assert.equal(db.readSeasonHistory(1, "all").total, 151);
});

test("HTTP head refreshes cannot starve archive import or leave the cursor beyond an outage gap", async (t) => {
  const db = store(t); const calls = [];
  db.publishArchive({ page: 7, pages: 20, total: 1, matches: [seasonMatch(1, AXIS_CURRENT_SEASON_START)] });
  const request = async url => {
    const page = Number(url.searchParams.get("page")), size = Number(url.searchParams.get("page_size"));
    calls.push([page, size]);
    return Response.json({ data: Array.from({ length: Math.min(size, 127 - (page - 1) * size) }, (_, i) => historyMatch(127 - (page - 1) * size - i)),
      pagination: { current_page: page, per_page: size, total_pages: Math.ceil(127 / size), total_items: 127 } });
  };
  await refreshAxisArchive(db, request, AXIS_REFRESH_MS, true);
  assert.equal(db.archiveState().complete, 0);
  assert.equal(db.archiveState().next_page, 2, "head requests must restart the cursor atomically when they discover a gap");
  await refreshAxisArchive(db, request, AXIS_REFRESH_MS + 30_000, true);
  assert.deepEqual(calls, [[1, 25]], "HTTP fallback must not take the worker's next import slot");
  await refreshAxisArchive(db, request, AXIS_REFRESH_MS + 30_000);
  assert.deepEqual(calls, [[1, 25], [1, 50], [2, 50], [3, 50]]);
  assert.equal(db.archiveState().complete, 1);
  assert.equal(db.readSeasonHistory(1, "all").total, 127);
});

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

test("archive fetch uses a fixed server, bounded page size and newest-first order", async (t) => {
  await refreshAxisArchive(store(t), async (url, options) => {
    assert.equal(url.origin, "https://api.neatqueue.com");
    assert.equal(url.pathname, `/api/v1/history/${AXIS_SERVER_ID}`);
    assert.equal(url.searchParams.get("page"), "1");
    assert.equal(url.searchParams.get("page_size"), "50");
    assert.equal(url.searchParams.get("order"), "desc");
    assert.equal(options.cache, "no-store");
    assert.ok(options.signal instanceof AbortSignal);
    const body = historyPage(1, 1); body.pagination.per_page = 50;
    return Response.json(body);
  }, AXIS_REFRESH_MS);
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

test("concurrent archive refreshes share one request and retain saved data on failure", async (t) => {
  const db = store(t);
  let calls = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  const request = async () => { calls++; await gate; const body = historyPage(1, 1); body.pagination.per_page = 50; return Response.json(body); };
  const first = refreshAxisArchive(db, request, AXIS_REFRESH_MS);
  const duplicate = refreshAxisArchive(db, request, AXIS_REFRESH_MS);
  assert.equal(calls, 1);
  release(); await Promise.all([first, duplicate]);
  assert.equal(db.readSeasonHistory(1, "all").matches.length, 1);
  await refreshAxisArchive(db, async () => new Response(null, { status: 429 }), AXIS_REFRESH_MS * 2);
  assert.equal(db.readSeasonHistory(1, "all").available, true);
  assert.equal(db.readSeasonHistory(1, "all").stale, true);
  assert.equal(db.readSeasonHistory(1, "all").matches.length, 1);
});

test("archive five-minute leases coordinate separate SQLite store handles", (t) => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const one = createAxisLeagueStore(db), two = createAxisLeagueStore(db);
  one.publishArchive({ page: 1, pages: 1, total: 0, matches: [] });
  assert.equal(one.claimArchiveRefresh(AXIS_REFRESH_MS), true);
  assert.equal(two.claimArchiveRefresh(AXIS_REFRESH_MS + 1), false);
  assert.equal(two.claimArchiveRefresh(AXIS_REFRESH_MS * 2), true);
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


test("preview cache skips repeated and unrelated reads, caps history, and invalidates across SQLite handles", async (t) => {
  const { join } = await import("node:path"), { tmpdir } = await import("node:os");
  const { randomUUID } = await import("node:crypto"), { existsSync, unlinkSync } = await import("node:fs");
  const path = join(tmpdir(), `axis-preview-${randomUUID()}.db`);
  const first = new DatabaseSync(path), second = new DatabaseSync(path);
  t.after(() => { second.close(); first.close(); for (const suffix of ["", "-wal", "-shm", "-journal"]) if (existsSync(path + suffix)) unlinkSync(path + suffix); });
  let aggregateQueries = 0;
  const traced = { exec: sql => first.exec(sql), prepare: sql => { if (sql.includes("WITH recorded AS")) aggregateQueries++; return first.prepare(sql); } };
  const db = createAxisLeagueStore(traced), writer = createAxisLeagueStore(second);
  db.publish(parseAxisPage(page([row("1")])).players);
  const matches = Array.from({ length: 8 }, (_, i) => seasonMatch(i + 1, AXIS_CURRENT_SEASON_START + i));
  db.publishArchive({ matches, page: 1, pages: 1, total: 8 });
  const zero = { kills: 0, deaths: 0, assists: 0 };
  for (const match of matches) db.setMatchStats(match.number, [{ discordId: "1", kda: zero, expected: null }]);
  assert.deepEqual(db.read().players[0].recentMatches.map(match => match.number), [3, 4, 5, 6, 7, 8]);
  assert.equal(db.read().averageKda, 0);
  for (let i = 0; i < 100; i++) db.read();
  assert.equal(aggregateQueries, 1);
  first.exec("CREATE TABLE unrelated(value INTEGER); INSERT INTO unrelated VALUES(1)");
  writer.failRefresh(); db.read();
  assert.equal(aggregateQueries, 1, "unrelated writes must not invalidate match statistics");
  writer.setMatchStats(8, [{ discordId: "1", kda: { kills: 7, deaths: 0, assists: 2 }, expected: zero }]);
  assert.equal(db.read().players[0].recentMatches.at(-1).kills, 7);
  assert.equal(aggregateQueries, 2);
  assert.equal(db.read().averageKda, 9 / 8);
  // Raw writes simulate an already-running worker that predates the application cache.
  second.prepare("UPDATE axis_match_kda SET kills=11 WHERE match_number=8 AND discord_id='1'").run();
  assert.equal(db.read().players[0].combatStats.kills, 11);
  assert.equal(aggregateQueries, 3);
  second.prepare("DELETE FROM axis_match_kda WHERE match_number=8 AND discord_id='1'").run();
  assert.deepEqual(db.read().players[0].recentMatches.map(match => match.number), [2, 3, 4, 5, 6, 7]);
  assert.equal(aggregateQueries, 4);
});


test("preview outcomes follow the recorded player's team rather than assuming the first team won", (t) => {
  const db = store(t);
  db.publish(parseAxisPage(page([row("1"), row("6")])).players);
  const match = seasonMatch(90, AXIS_CURRENT_SEASON_START + 90);
  const roster = match.teams[0].players;
  match.teams = [{ name: null, players: roster.slice(0, 5) }, { name: null, players: roster.slice(5) }];
  match.winner = 1;
  db.publishArchive({ matches: [match], page: 1, pages: 1, total: 1 });
  const kda = { kills: 12, deaths: 3, assists: 2 };
  db.setMatchStats(90, [{ discordId: "1", kda, expected: null }, { discordId: "6", kda, expected: null }]);
  assert.equal(db.read().players[0].recentMatches[0].won, false);
  assert.equal(db.read().players[1].recentMatches[0].won, true);
});


test("private match photos survive reopening and imports without entering public history or invalidating standings", async t => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "axis-photo-store-"));
  let db = new DatabaseSync(join(dir, "league.db"));
  t.after(async () => { db.close(); await rm(dir, { recursive: true, force: true }); });
  let store = createAxisLeagueStore(db);
  const match = { number: 7, time: Date.now(), queueId: AXIS_CHANNEL_ID, queue: "AXIS", maps: [], winner: 0, teams: [{ name: null, players: [] }] };
  const page = { page: 1, pages: 1, total: 1, matches: [match] };
  store.publishArchive(page);
  const revision = db.prepare("SELECT revision FROM axis_preview_state WHERE id=1").get().revision;
  const data = Buffer.from("stored image bytes");
  const photo = { revision: "a".repeat(64), width: 128, height: 72, data };
  store.setMatchPhoto(7, null, photo);
  assert.equal(db.prepare("SELECT revision FROM axis_preview_state WHERE id=1").get().revision, revision);
  db.close(); db = new DatabaseSync(join(dir, "league.db")); store = createAxisLeagueStore(db);
  store.publishArchive(page);
  assert.deepEqual(Buffer.from(store.readMatchPhoto(7).data), data);
  assert.deepEqual(store.readMatchPhotoMetadata(7), { revision: photo.revision, width: 128, height: 72 });
  assert.equal("photo" in store.readMatchHistory(7).matches[0], false);
  assert.equal("photo" in store.readSeasonHistory(1, "all").matches[0], false);
  assert.throws(() => store.setMatchPhoto(7, null, null), AxisKdaConflict);
  assert.deepEqual(Buffer.from(store.readMatchPhoto(7).data), data);
});
