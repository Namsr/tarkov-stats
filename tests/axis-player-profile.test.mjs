import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { createAxisLeagueStore } from "../lib/admin/axis-league-db.ts";
import { AXIS_CHANNEL_ID, axisKdaRatio } from "../lib/axis-league.ts";
import { AXIS_CURRENT_SEASON_START } from "../lib/axis-seasons.ts";
import { axisPlayerHref, buildAxisPlayerSummary } from "../lib/axis-player-profile.ts";

const avatar = id => `https://cdn.discordapp.com/avatars/${id}/abc.png?size=128`;
function player(id, overrides = {}) {
  return { id, name: `Player ${id}`, avatarUrl: avatar(id), position: Number(id), mmr: 1050, peakMmr: 1100,
    games: 24, wins: 13, losses: 11, winrate: 13 / 24, streak: 2, peakStreak: 5, profile: null, ...overrides };
}
function match(i, overrides = {}) {
  const ownTeam = i % 2, won = i < 12 ? i % 4 !== 0 : i % 3 === 0;
  const roster = id => ({ id, name: `Player ${id}`, avatarUrl: avatar(id), profile: null, mmr: 1000, change: won ? 25 : -25 });
  const teams = [{ name: null, players: [] }, { name: null, players: [] }];
  teams[ownTeam].players = [roster("1"), roster(i < 12 ? "2" : "3")];
  teams[1 - ownTeam].players = [roster(i < 12 ? "3" : "2")];
  return { number: i + 100, time: AXIS_CURRENT_SEASON_START + (i + 1) * 60_000, queueId: AXIS_CHANNEL_ID, queue: "Arena League",
    winner: won ? ownTeam : 1 - ownTeam, maps: [i % 2 ? "Bowl" : "Fort"], teams, ...overrides };
}
function setup(t, traced) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const store = createAxisLeagueStore(traced?.(db) ?? db);
  store.publish([player("1"), player("2"), player("3")]);
  store.setProfile("1", { aid: 12345, mode: "arena" });
  store.setProfile("2", { aid: 23456, mode: "arena" });
  store.preparePlayerProfiles();
  return { db, store };
}
function publish(store, matches) { store.publishArchive({ matches: [...matches].reverse(), total: matches.length, pages: 1, page: 1 }); }
function storyMatch(i, result, map = "Bowl") {
  const entry = match(i, { maps: [map] }), own = i % 2;
  const roster = id => ({ id, name: `Player ${id}`, profile: null, mmr: 1000, change: 25 });
  entry.teams[own].players = [roster("1"), roster("3")];
  entry.teams[1 - own].players = [roster("2")];
  entry.winner = result === "win" ? own : result === "loss" ? 1 - own : result === "draw" ? -2 : -1;
  return entry;
}

test("profile summary uses the player's team, exact relationship records, linked avatars, maps and nullable last-ten KDA", t => {
  const { store } = setup(t);
  const matches = Array.from({ length: 24 }, (_, i) => match(i));
  matches.push(match(24, { winner: -2 }), match(25, { winner: -1 }), match(26, { winner: null }), match(27, { queueId: "999" }));
  matches[1].maps = ["Bowl", "Bowl"];
  matches[2].maps = ["Bowl", "Fort"];
  publish(store, matches);
  for (let i = 0; i < 25; i++) if (i % 4 !== 0) store.setMatchStats(i + 100, [{ discordId: "1", expected: null,
    kda: i === 5 ? { kills: 0, deaths: 0, assists: 0 } : { kills: i, deaths: 2, assists: 1 } }]);
  const result = store.readPlayerProfile(12345);
  assert.equal(result.identity.avatarUrl, avatar("1"));
  assert.equal(result.stats.games, 24, "current statistics stay identical to the saved mini-profile");
  assert.equal(result.history.total, 27, "history includes cancelled/pending games but never another queue");
  assert.equal(result.history.matches.length, 10);
  assert.equal(result.archivedGames, 25);
  assert.equal(result.recent.length, 10);
  assert.equal(result.recent[0].number, 124);
  assert.equal(result.recent[0].kda, null, "missing KDA remains absent, not zero");
  assert.equal(result.combat.matches, 18);
  const teammate = result.highlights.teammate;
  assert.equal(teammate.id, "2"); assert.equal(teammate.wins, 9); assert.equal(teammate.losses, 3); assert.equal(teammate.winrate, .75);
  const opponent = result.highlights.opponent;
  assert.equal(opponent.id, "2"); assert.equal(opponent.wins, 4); assert.equal(opponent.losses, 8); assert.equal(opponent.winrate, 1 / 3);
  assert.equal(opponent.games, 13, "the draw is counted as a shared game but not a decided-match denominator");
  assert.equal(result.highlights.ally.with.id, "2");
  assert.equal(teammate.profile.aid, 23456);
  assert.equal(teammate.avatarUrl, avatar("2"));
  assert.equal(result.maps.reduce((n, entry) => n + entry.games, 0), 25);
  assert.ok(result.maps.every(entry => !entry.name.includes("Bowl / Bowl")));
  assert.equal(result.maps.find(entry => entry.name === "Bowl / Fort").games, 1, "one match outcome belongs to the map combination, not to two invented map outcomes");
  assert.equal(store.readPlayerProfile(12345, "current", 1, "win").history.total, 13);
  assert.equal(store.readPlayerProfile(12345, "current", 1, "loss").history.total, 11);
  assert.equal(store.readPlayerProfile(12345, "current", 2).history.matches[0].number, 116);
  assert.equal(axisPlayerHref({ aid: 23456, mode: "regular" }), "/player/arena/23456?arenaMode=axis");
});

test("identity lookup prefers the Arena mapping, allows one unambiguous account mapping and rejects ambiguity", t => {
  const { store } = setup(t);
  store.setProfile("3", { aid: 12345, mode: "regular" });
  assert.equal(store.readPlayerIdentity(12345).id, "1");
  store.setProfile("1", null);
  assert.equal(store.readPlayerIdentity(12345).id, "3");
  store.setProfile("2", { aid: 12345, mode: "pve" });
  assert.equal(store.readPlayerIdentity(12345), null);
  assert.equal(store.readPlayerProfile(99999), null);
});

test("participant index handles old-worker inserts, corrected rosters, duplicate IDs and deletion", t => {
  const { store, db } = setup(t);
  const write = db.prepare("INSERT INTO axis_archive_matches(number,payload) VALUES(?,?)");
  const original = match(0); original.teams[0].players.push({ ...original.teams[0].players[0] });
  write.run(original.number, JSON.stringify(original));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM axis_match_participants WHERE discord_id='1'").get().n, 1);
  assert.equal(store.readPlayerProfile(12345).history.total, 1);
  const corrected = match(0); corrected.teams.forEach(team => { team.players = team.players.filter(player => player.id !== "1"); });
  db.prepare("UPDATE axis_archive_matches SET payload=? WHERE number=?").run(JSON.stringify(corrected), original.number);
  assert.equal(store.readPlayerProfile(12345).history.total, 0);
  db.prepare("UPDATE axis_archive_matches SET payload=? WHERE number=?").run(JSON.stringify(match(0)), original.number);
  assert.equal(store.readPlayerProfile(12345).history.total, 1);
  db.prepare("DELETE FROM axis_archive_matches WHERE number=?").run(original.number);
  assert.equal(store.readPlayerProfile(12345).history.total, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM axis_match_participants").get().n, 0);
});

test("profile cache avoids repeat aggregation and invalidates for KDA, snapshot and mapping updates", t => {
  let aggregations = 0;
  const { store, db } = setup(t, db => ({ exec: sql => db.exec(sql), prepare(sql) {
    if (sql.includes("SELECT m.payload FROM axis_match_participants") && sql.includes("WHERE p.discord_id=? AND") && !sql.includes(" LIMIT ")) aggregations++;
    return db.prepare(sql);
  } }));
  publish(store, [match(0), match(1)]);
  for (let i = 0; i < 30; i++) store.readPlayerProfile(12345);
  assert.equal(aggregations, 1);
  store.claimRefresh(Date.now() + 1_000_000);
  store.failRefresh();
  store.publish([player("1"), player("2"), player("3")]);
  store.readPlayerProfile(12345);
  assert.equal(aggregations, 1, "unchanged snapshot content and refresh metadata preserve cached analytics");
  store.setMatchStats(101, [{ discordId: "1", kda: { kills: 10, deaths: 0, assists: 2 }, expected: null }]);
  assert.equal(axisKdaRatio(store.readPlayerProfile(12345).combat), 12);
  assert.equal(aggregations, 2);
  db.prepare("UPDATE axis_match_kda SET kills=20 WHERE discord_id='1'").run();
  assert.equal(store.readPlayerProfile(12345).combat.kills, 20);
  store.publish([player("1", { name: "Renamed", avatarUrl: avatar("55") }), player("2"), player("3")]);
  assert.equal(store.readPlayerProfile(12345).identity.name, "Renamed");
  assert.equal(store.readPlayerProfile(12345).identity.avatarUrl, avatar("55"));
  store.setProfile("2", null);
  assert.equal(store.readPlayerProfile(12345).teammates.find(player => player.id === "2").profile, null);
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT m.payload FROM axis_match_participants p JOIN axis_archive_matches m ON m.number=p.match_number WHERE p.discord_id=? ORDER BY p.match_number DESC LIMIT 10").all("1");
  assert.ok(plan.some(row => row.detail.includes("axis_participant_player")), JSON.stringify(plan));
});

test("old seasons stay scoped and partial archive responses explicitly report incomplete coverage", t => {
  const { store } = setup(t);
  publish(store, [match(0, { time: AXIS_CURRENT_SEASON_START - 1000 }), match(1)]);
  const old = store.readPlayerProfile(12345, "all");
  assert.equal(old.history.total, 2); assert.equal(old.stats.position, null);
  assert.equal(store.readPlayerProfile(12345).history.total, 1);
  store.publishArchive({ page: 1, pages: 2, total: 100, matches: [match(1)] });
  assert.equal(store.readPlayerProfile(12345).history.archiveComplete, false);
  assert.equal(store.readPlayerProfile(12345).combat, null);
});

test("one-time migration backfills a 5000-match archive and subsequent opens skip the backfill", t => {
  const { db } = setup(t);
  db.exec("DROP TRIGGER axis_participant_insert; DROP TRIGGER axis_participant_update; DROP TRIGGER axis_participant_delete; DELETE FROM axis_match_participants; UPDATE axis_participant_migration SET ready=0");
  const save = db.prepare("INSERT INTO axis_archive_matches(number,payload) VALUES(?,?)");
  db.exec("BEGIN");
  for (let i = 0; i < 5000; i++) { const entry = match(i); save.run(entry.number, JSON.stringify(entry)); }
  db.exec("COMMIT");
  const start = performance.now();
  const reopened = createAxisLeagueStore(db);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM axis_match_participants").get().n, 0, "opening any Arena profile cannot trigger an archive backfill");
  assert.throws(() => reopened.readPlayerProfile(12345), /preparation pending/);
  reopened.preparePlayerProfiles();
  const elapsed = performance.now() - start;
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM axis_match_participants").get().n, 15000);
  let backfills = 0;
  createAxisLeagueStore({ prepare: sql => db.prepare(sql), exec(sql) { if (sql.includes("SELECT m.number,json_extract")) backfills++; db.exec(sql); } }).preparePlayerProfiles();
  assert.equal(backfills, 0);
  t.diagnostic(`5000-match SQLite in-memory backfill: ${elapsed.toFixed(1)} ms; network latency and production disk latency unmeasured`);
});

test("last-ten league KDA ranks completed games before skipping missing KDA", t => {
  const { store } = setup(t);
  publish(store, Array.from({ length: 12 }, (_, i) => match(i)));
  for (let i = 0; i < 11; i++) store.setMatchStats(100 + i, [{ discordId: "1", expected: null, kda: { kills: i < 2 ? 100 : 10, deaths: 1, assists: 0 } }]);
  const result = store.readPlayerProfile(12345);
  assert.equal(result.averageRecentKda, 10);
  assert.ok(result.averageKda > result.averageRecentKda);
  assert.equal(result.recent.filter(match => match.kda).length, 9);
});

test("identity fallback is limited to the Axis queue", t => {
  const { store } = setup(t);
  publish(store, [match(0), match(1, { queueId: "other", teams: [{ players: [{ id: "1", name: "Wrong queue", mmr: 0, change: 0, profile: null }] }] })]);
  store.publish([player("2"), player("3")]);
  assert.equal(store.readPlayerIdentity(12345).name, "Player 1");
});

test("season stories distinguish most shared wins from highest win rate and ignore tiny map samples", t => {
  const { store } = setup(t);
  const matches = Array.from({ length: 30 }, (_, i) => {
    const entry = storyMatch(i, i < 10 ? i < 9 ? "win" : "loss" : i < 20 ? "win" : "loss", i < 10 ? "Bowl" : "Fort");
    if (i < 10) {
      entry.teams[i % 2].players[1].id = "2";
      entry.teams[1 - i % 2].players[0].id = "3";
    }
    return entry;
  });
  matches.push(storyMatch(30, "win", "One match"), storyMatch(31, "draw"));
  publish(store, matches);
  const data = store.readPlayerProfile(12345);
  assert.equal(data.highlights.teammate.id, "2", "highest win rate remains the existing highlight");
  assert.equal(data.story.mostWinsWith.id, "3");
  assert.equal(data.story.mostWinsWith.wins, 11);
  assert.equal(data.story.bestMap.name, "Bowl");
  assert.equal(data.story.bestMap.games, 11);
  assert.equal(data.story.bestMap.winrate, .9, "draws do not become losses");
  assert.deepEqual(store.readPlayerProfile(12345, "current", 2, "loss").story, data.story, "history filters and pages cannot alter the season story");
});

test("revenge requires three consecutive losses to the same opponent and links the latest qualifying win", t => {
  const { store } = setup(t);
  publish(store, ["loss", "loss", "loss", "loss", "win", "loss", "loss", "loss", "win"].map((result, i) => storyMatch(i, result)));
  const revenge = store.readPlayerProfile(12345).story.revenge;
  assert.equal(revenge.opponent.id, "2");
  assert.equal(revenge.matchNumber, 108);
  assert.equal(revenge.losses, 3, "the older four-loss recovery cannot replace a newer event");
  store.publishArchive({ page: 1, pages: 2, total: 100, matches: [storyMatch(8, "win")] });
  assert.equal(store.readPlayerProfile(12345).story.revenge, null, "a partial archive cannot prove consecutive head-to-head losses");
});

test("draws and wins break a revenge loss streak; empty and short periods do not invent facts", t => {
  const { store, db } = setup(t);
  assert.deepEqual(store.readPlayerProfile(12345).story, { mostWinsWith: null, revenge: null, bestMap: null });
  for (const results of [["loss", "loss", "draw", "loss", "win"], ["loss", "loss", "win", "loss", "win"]]) {
    db.exec("DELETE FROM axis_archive_matches");
    publish(store, results.map((result, i) => storyMatch(i, result)));
    assert.equal(store.readPlayerProfile(12345).story.revenge, null);
  }
  db.exec("DELETE FROM axis_archive_matches");
  const matches = ["loss", "loss", "loss", "win"].map((result, i) => storyMatch(i, result));
  matches.slice(0, 3).forEach((entry, i) => { entry.time = AXIS_CURRENT_SEASON_START - (3 - i) * 60_000; });
  publish(store, matches);
  assert.equal(store.readPlayerProfile(12345).story.revenge, null, "current season never borrows older defeats");
  assert.equal(store.readPlayerProfile(12345).story.bestMap, null);
  assert.equal(store.readPlayerProfile(12345, "all").story.revenge.losses, 3);
});

test("toughest opponent requires twice as many losses as wins and prioritizes decided match count", () => {
  const identity = { id: "1", name: "Profile owner", avatarUrl: null, profile: { aid: 12345, mode: "arena" } };
  let serial = 0;
  const games = (id, results) => results.map(result => {
    const entry = storyMatch(serial++, result);
    entry.teams.flatMap(team => team.players).find(player => player.id === "2").id = id;
    return entry;
  });
  const summary = matches => buildAxisPlayerSummary(identity, matches.reverse(), [], false, {}, null, true);
  const shaw = games("shaw", [...Array(9).fill("win"), ...Array(7).fill("loss"), "draw"]);
  const recer = games("recer", [...Array(6).fill("win"), "loss"]);
  const data = summary([...shaw, ...recer]);
  assert.equal(data.highlights.opponent, null, "a 9-7 record cannot be described as a losing matchup");
  const peer = data.opponents.find(player => player.id === "shaw");
  assert.equal(peer.winrate, 9 / 16);
  assert.equal(peer.draws, 1);
  assert.equal(data.opponents.find(player => player.id === "recer").winrate, 6 / 7, "wins belong to the profile owner");
  const draws = games("draws", Array(10).fill("draw"));
  assert.equal(summary(draws).highlights.opponent, null, "draws cannot create a losing matchup");
  const short = games("short", ["loss", "draw"]);
  assert.equal(summary(short).highlights.opponent.id, "short", "there is no arbitrary minimum number of matches");
  const tie = games("tie", [...Array(4).fill("win"), ...Array(4).fill("loss")]);
  assert.equal(summary(tie).highlights.opponent, null, "a tied record is not a losing matchup");
  const close = games("close", [...Array(4).fill("win"), ...Array(5).fill("loss")]);
  assert.equal(summary(close).highlights.opponent, null, "4-5 is too close to call a tough matchup");
  const boundary = games("boundary", ["win", "loss", "loss"]);
  assert.equal(summary(boundary).highlights.opponent.id, "boundary", "exactly two losses per win qualifies");
  const swept = games("eight", Array(8).fill("loss"));
  const moreLosses = games("many", [...Array(3).fill("win"), ...Array(9).fill("loss")]);
  const toughest = summary([...shaw, ...recer, ...short, ...draws, ...tie, ...swept, ...moreLosses]).highlights.opponent;
  assert.equal(toughest.id, "many", "a sustained losing matchup outranks a shorter sweep");
  assert.equal(toughest.wins, 3);
  assert.equal(toughest.losses, 9);
  assert.equal(toughest.winrate, .25);
  const two = games("two", ["loss", "loss"]);
  const six = games("six", [...Array(2).fill("win"), ...Array(4).fill("loss")]);
  const nine = games("nine", [...Array(3).fill("win"), ...Array(6).fill("loss")]);
  assert.equal(summary([...two, ...six, ...nine]).highlights.opponent.id, "nine", "3-6 outranks 0-2 and 2-4");
  const ten = games("ten", [...Array(2).fill("win"), ...Array(8).fill("loss")]);
  assert.equal(summary([...nine, ...ten, ...close, ...shaw]).highlights.opponent.id, "ten", "2-8 outranks 3-6; close records remain ineligible");
  const equalGames = games("equal", [...Array(2).fill("win"), ...Array(7).fill("loss")]);
  assert.equal(summary([...nine, ...equalGames]).highlights.opponent.id, "equal", "higher loss rate breaks equal decided-match counts");
  const drawnSweep = games("drawn", ["loss", "loss", ...Array(20).fill("draw")]);
  assert.equal(summary([...drawnSweep, ...nine]).highlights.opponent.id, "nine", "draws cannot inflate the matchup sample");
});
