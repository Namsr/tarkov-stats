import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { AXIS_PREDICTION_VERSION, buildAxisWinProbabilities } from "../lib/axis-win-probability.ts";
import { createAxisLeagueStore } from "../lib/admin/axis-league-db.ts";
import { AXIS_CHANNEL_ID } from "../lib/axis-league.ts";
import { dict } from "../lib/i18n/dictionary.ts";
import { createAxisProbabilityCalibration } from "../lib/axis-probability-calibration.ts";
import { backtestAxisProbabilities, summarizeAxisProbabilities } from "../scripts/backtest-axis-probability.mjs";

const DAY = 86_400_000, START = Date.parse("2026-10-17T00:00:00Z");
function match(number, a = ["1", "2"], b = ["3", "4"], winner = 0) {
  return { number, time: START + number * 60_000, queueId: AXIS_CHANNEL_ID, queue: "Arena League", maps: ["Skybridge"], winner,
    teams: [a, b].map(ids => ({ name: null, players: ids.map(id => ({ id, name: `Player ${id}`, profile: null, mmr: 1000, change: 25 })) })) };
}
const probability = (history, target) => buildAxisWinProbabilities([...history, target]).get(target.number).a;
const archive = matches => ({ page: 1, pages: 1, total: matches.length, matches });
function calibrationHistory() {
  return Array.from({ length: 100 }, (_, i) => {
    const game = match(i + 1, ["51", "52"], ["53", "54"], i % 4 === 3 ? 1 : 0);
    game.teams.forEach((team, index) => team.players.forEach(p => { p.mmr = index === 0 ? 1200 : 1000; p.change = 0; }));
    return game;
  });
}
function store(t) {
  const sql = new DatabaseSync(":memory:"); t.after(() => sql.close());
  return { sql, db: createAxisLeagueStore(sql) };
}

test("cold starts without calibration evidence stay neutral even with unequal ratings", () => {
  const target = match(1);
  assert.equal(probability([], target), .5);
  target.teams[0].players.forEach(p => { p.mmr = 1100; });
  assert.equal(probability([], target), .5);
  target.teams.forEach(team => team.players.forEach(p => { p.mmr = null; }));
  assert.equal(probability([], target), .5);
});

test("missing MMR falls back to the last known rating from earlier games", () => {
  const history = calibrationHistory();
  const past = match(150, undefined, undefined, -2);
  past.teams[0].players.forEach(p => { p.mmr = 1100; p.change = 0; });
  past.teams[1].players.forEach(p => { p.change = 0; });
  const target = match(200), missing = structuredClone(target);
  target.teams[0].players.forEach(p => { p.mmr = 1100; });
  missing.teams.forEach(team => team.players.forEach(p => { p.mmr = null; }));
  assert.equal(probability([...history, past], missing), probability([...history, past], target));
  assert.ok(probability([...history, past], target) > .5);
});

test("calibration learns observed win frequency from out-of-sample scores", () => {
  for (const [raw, wins] of [[.9, 6], [.6, 7]]) {
    const calibration = createAxisProbabilityCalibration(), logit = Math.log(raw / (1 - raw));
    assert.equal(calibration.probability(logit), .5);
    for (let i = 0; i < 2000; i++) calibration.observe(logit, i % 10 < wins ? 1 : 0);
    const p = calibration.probability(logit);
    assert.ok(Math.abs(p - wins / 10) < .03, `${raw} calibrated to ${p}`);
    assert.ok(Math.abs(calibration.probability(-logit) - (1 - p)) < 1e-12);
    assert.equal(calibration.probability(0), .5);
  }
});

test("calibration forgets old regimes, stays finite with zero scores and validates observations", () => {
  const calibration = createAxisProbabilityCalibration();
  for (let i = 0; i < 2000; i++) calibration.observe(2, 1);
  assert.ok(calibration.probability(2) > .8);
  for (let i = 0; i < 1000; i++) calibration.observe(2, i % 2);
  assert.ok(calibration.probability(2) < .55);
  const zero = createAxisProbabilityCalibration();
  for (let i = 0; i < 1000; i++) zero.observe(0, i % 2);
  assert.equal(zero.probability(0), .5);
  assert.throws(() => zero.observe(Infinity, 1), TypeError);
  assert.throws(() => zero.observe(1, .5), TypeError);
  assert.throws(() => zero.probability(NaN), TypeError);
});

test("backtest measures frequency calibration without counting 50/50 as a successful favorite", () => {
  const result = summarizeAxisProbabilities([{ a: .6, winner: 0 }, { a: .6, winner: 1 }, { a: .5, winner: 0 }, { a: .8, winner: 0 }]);
  assert.equal(result.n, 4); assert.equal(result.favoritePredictions, 3); assert.equal(result.correct, 2);
  assert.equal(result.equalOdds, 1); assert.equal(result.accuracy, 2 / 3);
  assert.ok(Math.abs(result.brier - .2025) < 1e-12);
  assert.ok(Math.abs(result.ece - .225) < 1e-12);
  assert.ok(Math.abs(result.favoriteEce - 2 / 15) < 1e-12);
  assert.equal(summarizeAxisProbabilities([]).brier, null);
});

test("backtest keeps simultaneous matches on one side of the evaluation split", () => {
  const matches = [match(1), match(2), match(3), match(4)];
  matches[1].time = matches[2].time;
  const result = backtestAxisProbabilities(matches, 2);
  assert.equal(result.development.n, 3); assert.equal(result.validation.n, 1);
  assert.equal(result.split.developmentLastMatch, 3); assert.equal(result.split.validationFirstMatch, 4);
  assert.throws(() => backtestAxisProbabilities(matches, NaN), TypeError);
  assert.throws(() => backtestAxisProbabilities([...matches, matches[0]], 2), TypeError);
});

test("undated games do not display an uncalibrated Elo forecast or train other predictions", () => {
  const target = match(999); target.time = null;
  target.teams[0].players.forEach(p => { p.mmr = 1200; });
  assert.equal(buildAxisWinProbabilities([target]).has(target.number), false);
  for (const winner of [0, 1]) {
    const history = Array.from({ length: 200 }, (_, i) => {
      const game = match(i + 1, undefined, undefined, winner);
      game.teams[0].players.forEach(p => { p.mmr = 1800; p.change = 25; });
      return game;
    });
    assert.deepEqual(buildAxisWinProbabilities([...history, target]), buildAxisWinProbabilities(history));
  }
});

test("past peaks transfer across resets without target, simultaneous or future rating leakage", () => {
  const warmup = (number, a, b, rating) => {
    const game = match(number, a, b, -2);
    game.time = START - DAY * 10 + number * 60_000;
    game.teams.forEach(team => team.players.forEach(p => { p.mmr = rating; p.change = 0; }));
    return game;
  };
  const history = [warmup(1, ["1", "2"], ["5", "6"], 1800), warmup(2, ["3", "4"], ["7", "8"], 1000),
    warmup(3, ["11", "12"], ["15", "16"], 1800), warmup(4, ["13", "14"], ["17", "18"], 1000)];
  for (let i = 0; i < 200; i++) {
    const game = match(i + 10, ["1", "2"], ["3", "4"], i % 10 < 7 ? 0 : 1);
    game.teams.forEach(team => team.players.forEach(p => { p.change = 0; }));
    history.push(game);
  }
  // These players have no win/loss, KDA, map, pair or encounter evidence. The
  // only distinguishing past observation is their pre-reset peak rating.
  const target = match(300, ["11", "12"], ["13", "14"]);
  const p = probability(history, target);
  // The effect is learned, rather than a hard-coded bonus for a former peak.
  assert.notEqual(p, .5);
  const reversed = structuredClone(target); reversed.teams.reverse();
  assert.equal(Math.round((p + probability(history, reversed)) * 1000), 1000);
  const equalPeaks = structuredClone(history);
  equalPeaks[2].teams.forEach(team => team.players.forEach(p => { p.mmr = 1000; }));
  assert.equal(probability(equalPeaks, target), .5);
  const later = warmup(400, ["13", "14"], ["17", "18"], 5000); later.time = target.time + DAY;
  assert.equal(probability([...history, later], target), p);
  later.time = target.time;
  assert.equal(probability([...history, later], target), p);
  const edited = structuredClone(target);
  edited.teams[1].players.forEach(p => { p.change = 5000; });
  assert.equal(probability(history, edited), p);
});

test("target outcome, MMR changes, rounds and KDA cannot leak into its probability", () => {
  const history = Array.from({ length: 12 }, (_, i) => match(i + 1));
  const target = match(20), before = structuredClone([...history, target]);
  const p = probability(history, target);
  const edited = structuredClone(target);
  edited.winner = 1; edited.rounds = { a: 0, b: 11 };
  edited.teams.forEach(team => team.players.forEach(p => { p.change = -999; p.kda = { kills: 9999, deaths: 0, assists: 9999 }; }));
  assert.equal(probability(history, edited), p);
  assert.deepEqual([...history, target], before);
});

test("predictions are chronological, independent of input order, and unchanged by future matches", () => {
  const history = Array.from({ length: 20 }, (_, i) => match(i + 1, undefined, undefined, i % 3 ? 0 : 1));
  const target = match(30), p = probability(history, target);
  assert.equal(probability([...history].reverse(), target), p);
  const future = Array.from({ length: 20 }, (_, i) => match(i + 100, undefined, undefined, 1));
  assert.equal(probability([...future, ...history], target), p);
  // A lower match number with a later time is still in the future.
  const odd = match(2); odd.time = target.time + DAY;
  assert.equal(probability([...history.filter(m => m.number !== 2), odd], target), probability(history.filter(m => m.number !== 2), target));
});

test("simultaneous games cannot use one another's results", () => {
  const first = match(1), second = match(2); second.time = first.time;
  assert.equal(probability([first], second), .5);
  first.winner = 1;
  assert.equal(probability([first], second), .5);
});

test("exchanging teams always complements the result, including learned encounters", () => {
  const history = Array.from({ length: 24 }, (_, i) => match(i + 1, undefined, undefined, i % 5 ? 0 : 1));
  const target = match(30), swapped = structuredClone(target); swapped.teams.reverse();
  const p = probability(history, target), q = probability(history, swapped);
  assert.equal(Math.round((p + q) * 1000), 1000);
  assert.ok(p > .5 && p <= .95);
  const reversedHistory = history.map(m => ({ ...m, teams: [...m.teams].reverse(), winner: 1 - m.winner }));
  assert.equal(probability(reversedHistory, swapped), q);
});

test("cancelled/pending matches and other queues do not contaminate the model", () => {
  const target = match(100);
  for (const winner of [null, -1]) {
    const history = Array.from({ length: 20 }, (_, i) => match(i + 1, undefined, undefined, winner));
    assert.equal(probability(history, target), .5);
  }
  const elsewhere = Array.from({ length: 20 }, (_, i) => ({ ...match(i + 1), queueId: "other" }));
  assert.equal(probability(elsewhere, target), .5);
});

test("historical KDA and round dominance affect later predictions, never zero-death infinities", () => {
  const history = [...calibrationHistory(), ...Array.from({ length: 20 }, (_, i) => match(i + 201, undefined, undefined, -2))];
  const target = match(230);
  assert.equal(probability(history, target), .5);
  for (const m of history.slice(100)) {
    m.teams[0].players.forEach(p => { p.kda = { kills: 20, deaths: 0, assists: 5 }; });
    m.teams[1].players.forEach(p => { p.kda = { kills: 3, deaths: 18, assists: 0 }; });
    m.rounds = { a: 11, b: 3 };
  }
  const p = probability(history, target);
  assert.ok(Number.isFinite(p) && p > .5 && p <= .95);
  const combatOnly = structuredClone(history); combatOnly.forEach(m => { delete m.rounds; });
  assert.ok(probability(combatOnly, target) > .5);
  const roundsOnly = structuredClone(history); roundsOnly.forEach(m => m.teams.forEach(team => team.players.forEach(p => { delete p.kda; })));
  assert.ok(probability(roundsOnly, target) > .5);
});

test("map history changes a prediction for the same roster and same personal totals", () => {
  const history = Array.from({ length: 40 }, (_, i) => ({ ...match(i + 1, undefined, undefined, i % 2), maps: [i % 2 ? "Fort" : "Skybridge"] }));
  const target = match(50), otherMap = { ...target, maps: ["Fort"] };
  assert.ok(probability(history, target) > probability(history, otherMap));
});

test("joint successes matter even when teammates have identical win/loss totals", () => {
  const history = [];
  for (let i = 0; i < 15; i++) {
    for (const [a, winner] of [[["1", "2"], 0], [["1", "3"], 1], [["2", "4"], 1], [["3", "5"], 0]]) {
      history.push(match(history.length + 1, a, [String(100 + history.length * 2), String(101 + history.length * 2)], winner));
    }
  }
  const target = match(100, ["1", "2"], ["98", "99"]);
  const alternative = match(100, ["1", "3"], ["98", "99"]);
  const counts = id => history.filter(m => m.teams[0].players.some(p => p.id === id)).reduce((s, m) => s + (m.winner === 0 ? 1 : -1), 0);
  assert.equal(counts("2"), 0); assert.equal(counts("3"), 0);
  assert.ok(probability(history, target) > probability(history, alternative));
});

test("old evidence loses influence; incomplete rosters cannot produce fabricated percentages", () => {
  const history = Array.from({ length: 20 }, (_, i) => match(i + 1));
  const target = match(30), late = { ...target, time: target.time + DAY * 365 * 2 };
  assert.ok(probability(history, target) > probability(history, late));
  assert.ok(Math.abs(probability(history, late) - .5) < .005);
  for (const broken of [match(30, [], []), match(30, ["1"], ["2", "3"]), match(30, ["1"], ["1"])]) {
    assert.equal(buildAxisWinProbabilities([broken]).has(30), false);
  }
  const noTime = { ...target, time: null };
  assert.equal(buildAxisWinProbabilities([...history, noTime]).has(noTime.number), false);
});

test("imports persist predictions, corrections replay later games and reopening keeps results", t => {
  const { sql, db } = store(t);
  const matches = Array.from({ length: 20 }, (_, i) => match(i + 1, undefined, undefined, i % 3 ? 0 : 1));
  db.publishArchive(archive(matches));
  const first = db.readMatchHistory(1).matches[0].winProbability;
  const last = db.readMatchHistory(20).matches[0].winProbability;
  assert.deepEqual(first, { a: .5, b: .5 }); assert.ok(last.a > .5);
  const reopened = createAxisLeagueStore(sql);
  assert.deepEqual(reopened.readSeasonHistory(1, "all").matches[0].winProbability, last);
  matches[0].winner = 0;
  reopened.publishArchive(archive(matches));
  assert.deepEqual(reopened.readMatchHistory(1).matches[0].winProbability, first);
  assert.notDeepEqual(reopened.readMatchHistory(20).matches[0].winProbability, last);
});

test("KDA/round edits refresh subsequent probabilities atomically and leave their own unchanged", t => {
  const { db } = store(t), matches = [match(1), match(2)];
  db.publishArchive(archive(matches));
  const own = db.readMatchHistory(1).matches[0].winProbability;
  const next = db.readMatchHistory(2).matches[0].winProbability;
  db.setMatchStats(1, [{ discordId: "1", kda: { kills: 25, deaths: 1, assists: 10 }, expected: null }], { score: { a: 11, b: 0 }, expected: null });
  assert.deepEqual(db.readMatchHistory(1).matches[0].winProbability, own);
  assert.notDeepEqual(db.readMatchHistory(2).matches[0].winProbability, next);
  const saved = db.readMatchHistory(2).matches[0].winProbability;
  assert.throws(() => db.setMatchStats(1, [{ discordId: "1", kda: { kills: 0, deaths: 0, assists: 0 }, expected: null }]));
  assert.deepEqual(db.readMatchHistory(2).matches[0].winProbability, saved);
  db.setMatchStats(1, [], { score: { a: 11, b: 10 }, expected: { a: 11, b: 0 } });
  assert.notDeepEqual(db.readMatchHistory(2).matches[0].winProbability, saved);
});

test("unchanged imports reuse the model; page reads never replay or parse the archive", t => {
  const { sql, db } = store(t), data = archive(Array.from({ length: 10 }, (_, i) => match(i + 1)));
  db.publishArchive(data);
  const before = sql.prepare("SELECT total_changes() AS n").get().n;
  db.publishArchive(data);
  // Only archive freshness metadata is updated, not prediction rows or state.
  assert.equal(sql.prepare("SELECT total_changes() AS n").get().n - before, 1);
  const prepare = sql.prepare.bind(sql);
  sql.prepare = query => {
    assert.doesNotMatch(query, /^SELECT payload FROM axis_archive_matches ORDER BY number$/);
    assert.doesNotMatch(query, /^SELECT \* FROM axis_match_kda$/);
    return prepare(query);
  };
  assert.equal(db.readMatchHistory(10).matches[0].winProbability.a > .5, true);
  assert.equal(db.readSeasonHistory(1, "all").matches.length, 10);
});

test("existing archives acquire predictions on the next unchanged import", t => {
  const { sql, db } = store(t), data = archive([match(1), match(2)]);
  db.publishArchive(data);
  sql.exec("DELETE FROM axis_match_predictions; UPDATE axis_prediction_state SET version=0");
  db.publishArchive(data);
  assert.equal(sql.prepare("SELECT count(*) AS n FROM axis_match_predictions").get().n, 2);
  assert.ok(db.readMatchHistory(2).matches[0].winProbability.a > .5);
});

test("unchanged KDA and round saves do not invalidate predictions and still detect stale editors", t => {
  const { sql, db } = store(t);
  db.publishArchive(archive([match(1), match(2)]));
  const kda = { kills: 10, deaths: 5, assists: 3 }, score = { a: 11, b: 8 };
  db.setMatchStats(1, [{ discordId: "1", kda, expected: null }], { score, expected: null });
  const revision = sql.prepare("SELECT revision FROM axis_preview_state").get().revision;
  const prepare = sql.prepare.bind(sql);
  sql.prepare = query => {
    assert.notEqual(query, "SELECT payload FROM axis_archive_matches ORDER BY number");
    return prepare(query);
  };
  db.setMatchStats(1, [{ discordId: "1", kda, expected: kda }], { score, expected: score });
  db.setMatchStats(1, [{ discordId: "2", kda: null, expected: null }], { score, expected: score });
  assert.equal(sql.prepare("SELECT revision FROM axis_preview_state").get().revision, revision);
  assert.throws(() => db.setMatchStats(1, [{ discordId: "1", kda: null, expected: null }]), /another administrator/);
  assert.throws(() => db.setMatchStats(1, [], { score: null, expected: null }), /another editor/);
});

test("metadata updates reuse predictions but unseen external statistics still require replay", t => {
  const { sql, db } = store(t), matches = [match(1), match(2)];
  db.publishArchive(archive(matches));
  const before = db.readMatchHistory(2).matches[0].winProbability;
  let replays = 0;
  const prepare = sql.prepare.bind(sql);
  sql.prepare = query => {
    if (query === "SELECT * FROM axis_match_kda") replays++;
    return prepare(query);
  };
  matches[0].queue = "Renamed queue"; // queueId is the actual model key.
  matches[0].teams[0].name = "Renamed team";
  Object.assign(matches[0].teams[0].players[0], { name: "Renamed player", avatarUrl: "https://example.com/avatar.png",
    profile: { aid: 123, mode: "arena" }, kda: { kills: 999, deaths: 0, assists: 999 } });
  matches[0].rounds = { a: 999, b: 0 }; // Authoritative KDA/rounds are in separate tables.
  db.publishArchive(archive(matches));
  assert.equal(replays, 0);
  assert.equal(db.readMatchHistory(1).matches[0].teams[0].players[0].name, "Renamed player");
  assert.deepEqual(db.readMatchHistory(2).matches[0].winProbability, before);
  sql.exec("INSERT INTO axis_match_kda VALUES(1,'1',25,1,10)");
  matches[0].teams[0].name = "Another name";
  db.publishArchive(archive(matches));
  assert.equal(replays, 1, "another process's unobserved data change cannot be skipped");
  assert.notDeepEqual(db.readMatchHistory(2).matches[0].winProbability, before);
});

test("every archived model input still invalidates saved predictions", t => {
  const mutations = [
    m => { m.time -= 1000; }, m => { m.queueId = "999"; }, m => { delete m.queueId; m.queue = "Unknown queue"; },
    m => { m.maps = ["Air Pit"]; }, m => { m.winner = 1; },
    m => { m.teams[0].players[0].id = "99"; }, m => { m.teams[0].players[0].mmr = 1100; },
    m => { m.teams[0].players[0].change = -25; }, m => { m.teams.reverse(); },
  ];
  for (const mutate of mutations) {
    const { sql, db } = store(t), matches = [match(1), match(2)];
    db.publishArchive(archive(matches));
    let replays = 0;
    const prepare = sql.prepare.bind(sql);
    sql.prepare = query => {
      if (query === "SELECT * FROM axis_match_kda") replays++;
      return prepare(query);
    };
    mutate(matches[0]); db.publishArchive(archive(matches));
    assert.equal(replays, 1);
  }
});

test("a page batch replays once, preserves timestamp batches and rolls back as one unit", t => {
  const { sql, db } = store(t), matches = [match(1), match(2), match(3)];
  matches[1].time = matches[0].time;
  const pages = matches.map((m, i) => ({ page: i + 1, pages: 3, total: 3, matches: [m] }));
  let replays = 0, fail = false;
  const prepare = sql.prepare.bind(sql);
  sql.prepare = query => {
    if (query === "SELECT * FROM axis_match_kda") replays++;
    if (fail && query.startsWith("UPDATE axis_prediction_state SET version=")) throw new Error("Simulated prediction failure");
    return prepare(query);
  };
  db.publishArchiveBatch(pages);
  assert.equal(replays, 1);
  const expected = buildAxisWinProbabilities(matches);
  for (const m of matches) assert.deepEqual(db.readMatchHistory(m.number).matches[0].winProbability, expected.get(m.number));
  assert.equal(db.archiveState().complete, 1);
  fail = true;
  assert.throws(() => db.publishArchiveBatch([{ page: 1, pages: 1, total: 4, matches: [match(4)] }]), /Simulated/);
  assert.equal(db.readMatchHistory(4).matches.length, 0);
  assert.deepEqual(db.readMatchHistory(3).matches[0].winProbability, expected.get(3));
  assert.equal(db.archiveState().complete, 1);
});

test("a previous model version rebuilds saved probabilities on an unchanged import", t => {
  const { sql, db } = store(t), data = archive([match(1), match(2)]);
  db.publishArchive(data);
  const correct = db.readMatchHistory(2).matches[0].winProbability;
  sql.prepare("UPDATE axis_prediction_state SET version=?").run(AXIS_PREDICTION_VERSION - 1);
  sql.exec("UPDATE axis_match_predictions SET a=0.123,b=0.877");
  db.publishArchive(data);
  assert.deepEqual(db.readMatchHistory(2).matches[0].winProbability, correct);
  assert.equal(sql.prepare("SELECT version FROM axis_prediction_state").get().version, AXIS_PREDICTION_VERSION);
});

test("appending a game preserves existing prediction rows; invalidated rosters remove their row", t => {
  const { sql, db } = store(t), matches = Array.from({ length: 10 }, (_, i) => match(i + 1));
  db.publishArchive(archive(matches));
  sql.exec(`CREATE TEMP TABLE prediction_writes(n INTEGER);
    CREATE TEMP TRIGGER count_prediction_insert AFTER INSERT ON axis_match_predictions BEGIN INSERT INTO prediction_writes VALUES(1); END;
    CREATE TEMP TRIGGER count_prediction_update AFTER UPDATE ON axis_match_predictions BEGIN INSERT INTO prediction_writes VALUES(1); END;`);
  matches.push(match(11)); db.publishArchive(archive(matches));
  assert.equal(sql.prepare("SELECT count(*) AS n FROM prediction_writes").get().n, 1);
  matches[0].teams[0].players = []; db.publishArchive(archive(matches));
  assert.equal(db.readMatchHistory(1).matches[0].winProbability, null);
});

test("probability UI renders localized percentages and accessible team labels without explanations", async () => {
  const require = createRequire(import.meta.url), ts = require("typescript");
  const { renderToStaticMarkup } = require("react-dom/server");
  const source = await readFile("components/AxisMatchProbability.tsx", "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  for (const lang of ["ru", "en"]) {
    const compiledModule = { exports: {} };
    const t = (key, values = {}) => Object.entries(values).reduce((s, [k, v]) => s.replace(`{${k}}`, v), dict[lang][key]);
    new Function("require", "module", "exports", compiled)(name => name === "@/lib/i18n/context" ? { useI18n: () => ({ t, lang }) } : require(name), compiledModule, compiledModule.exports);
    const target = match(1); target.winProbability = { a: .623, b: .377 };
    const html = renderToStaticMarkup(compiledModule.exports.default({ match: target }));
    assert.match(html, /role="group"/); assert.match(html, /aria-hidden="true"/);
    assert.ok(html.includes(dict[lang]["axis.prediction.label"]));
    assert.match(html, lang === "ru" ? /62,3/ : /62\.3/);
    assert.match(html, lang === "ru" ? /Команда A/ : /Team A/);
    assert.doesNotMatch(html, /NaN|undefined|title=|tooltip/);
  }
});

test("season averages use saved forecasts across every page, excluding draws and missing predictions", t => {
  const { sql, db } = store(t);
  const matches = Array.from({ length: 30 }, (_, i) => ({ ...match(i + 2, undefined, undefined, i < 27 ? 0 : 1), maps: [i < 15 ? "Bowl" : "Air Pit"] }));
  const old = { ...match(1), time: START - 30 * DAY };
  const other = { ...match(37), queueId: "other" };
  matches.push(match(32, undefined, undefined, -2), match(33, undefined, undefined, -1), match(34, undefined, undefined, null),
    { ...match(35), time: null }, match(36, [], []), other, old);
  db.publishArchive(archive(matches));
  const save = sql.prepare("UPDATE axis_match_predictions SET a=?,b=? WHERE number=?");
  for (let n = 2; n <= 31; n++) save.run(n <= 16 ? .6 : .4, n <= 16 ? .4 : .6, n);
  for (const n of [32, 33, 34, 37, 1]) save.run(.99, .01, n);
  sql.exec("DELETE FROM axis_match_predictions WHERE number IN (2,31)");
  const prepare = sql.prepare.bind(sql);
  sql.prepare = query => {
    assert.notEqual(query, "SELECT * FROM axis_match_kda", "history reads cannot replay the model");
    assert.notEqual(query, "SELECT payload FROM axis_archive_matches ORDER BY number", "no full archive parsing on a read");
    return prepare(query);
  };
  const summary = db.readSeasonHistory(1, "current").summary;
  assert.equal(summary.averageWinProbability.matches, 28);
  assert.ok(Math.abs(summary.averageWinProbability.a - .5) < 1e-12);
  assert.ok(Math.abs(summary.averageWinProbability.b - .5) < 1e-12);
  assert.equal(summary.winsA, 28); assert.equal(summary.winsB, 3);
  assert.equal(db.readSeasonHistory(2, "current").summary, summary);
  assert.equal(db.readSeasonHistory(1, "current", undefined, "Bowl").summary, summary);
  const previousSeason = db.readSeasonHistory(1, "all").seasons.find(s => !s.current);
  assert.equal(db.readSeasonHistory(1, previousSeason.id).summary.averageWinProbability.a, .99);
});

test("season average caches notice model backfill without archive changes and later KDA corrections", t => {
  const { sql, db: writer } = store(t), reader = createAxisLeagueStore(sql);
  const data = archive([match(1), match(2)]);
  writer.publishArchive(data);
  sql.exec("DELETE FROM axis_match_predictions; UPDATE axis_prediction_state SET version=0");
  assert.equal(reader.readSeasonHistory(1, "current").summary.averageWinProbability, null);
  const revision = sql.prepare("SELECT revision FROM axis_preview_state").get().revision;
  writer.publishArchive(data);
  assert.equal(sql.prepare("SELECT revision FROM axis_preview_state").get().revision, revision);
  const before = reader.readSeasonHistory(1, "current").summary.averageWinProbability;
  assert.equal(before.matches, 2);
  writer.setMatchStats(1, [{ discordId: "1", expected: null, kda: { kills: 25, deaths: 1, assists: 10 } }]);
  const after = reader.readSeasonHistory(1, "current").summary.averageWinProbability;
  assert.equal(after.matches, 2);
  assert.notEqual(after.a, before.a);
});

test("history renders season probabilities below team results in both languages with no extra fetch", async () => {
  const require = createRequire(import.meta.url), ts = require("typescript");
  const { renderToStaticMarkup } = require("react-dom/server");
  const source = await readFile("components/AxisMatchHistory.tsx", "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const ast = ts.createSourceFile("history.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let fetchCalls = 0;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "fetch") fetchCalls++;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(fetchCalls, 1, "the existing history request is the only fetch");
  for (const lang of ["ru", "en"]) for (const average of [{ a: .5125, b: .4875, matches: 88 }, null]) {
    const compiledModule = { exports: {} };
    const summary = { played: 88, winsA: 52, winsB: 36, maps: [], averageWinProbability: average };
    const data = { available: true, stale: false, page: 1, pages: 1, total: 88, season: "current", matches: [], summary };
    const states = [1, "current", undefined, undefined, data, [], false, 0, null];
    const t = (key, values = {}) => Object.entries(values).reduce((s, [k, v]) => s.replace(`{${k}}`, v), dict[lang][key]);
    new Function("require", "module", "exports", compiled)(name => {
      if (name === "react") return { useState: () => [states.shift(), () => {}], useRef: value => ({ current: value }), useId: () => "maps", useEffect: () => {} };
      if (name === "@/lib/i18n/context") return { useI18n: () => ({ t, lang }) };
      if (name === "@/lib/axis-league") return { AXIS_REFRESH_MS: 300_000 };
      if (name.startsWith("@/components/")) return { default: () => null };
      return require(name);
    }, compiledModule, compiledModule.exports);
    const html = renderToStaticMarkup(compiledModule.exports.default({ active: false }));
    assert.ok(html.includes(dict[lang]["axis.history.averageProbability"]));
    assert.match(html, /<strong>52<\/strong>/); assert.match(html, /<strong>36<\/strong>/);
    const percentages = [...html.matchAll(/<dd>([^<]*)<\/dd>/g)].slice(1).map(m => m[1]);
    if (average) {
      assert.ok(percentages[0].includes(lang === "ru" ? "51,3" : "51.3"));
      assert.ok(percentages[1].includes(lang === "ru" ? "48,7" : "48.7"));
    } else assert.deepEqual(percentages, ["—", "—"]);
    assert.doesNotMatch(html, /NaN|undefined|axis\.history\./);
  }
});
