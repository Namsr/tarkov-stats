import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AXIS_PREDICTION_VERSION, buildAxisWinProbabilities } from "../lib/axis-win-probability.ts";

const binary = fileURLToPath(new URL(`../rust/axis-probability/target/debug/axis-probability${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
const day = 86_400_000;
function match(i, overrides = {}) {
  const ids = i % 3 === 0 ? [["1", "2", "3"], ["4", "5", "6"]] : i % 3 === 1 ? [["1", "4", "7"], ["2", "5", "8"]] : [["3", "6", "9"], ["1", "5", "7"]];
  return { number: i + 1, time: 1_700_000_000_000 + Math.floor(i / 3) * 3_600_000, queueId: "main", queue: "league", maps: i % 4 ? [" SKYBRIDGE ", "fort", "Fort", " "] : ["fort"], winner: [0, 0, 1, -2, null, -1][i % 6],
    teams: ids.map((team, side) => ({ name: null, players: team.map((id, j) => ({ id, name: id, profile: null,
      mmr: (i + j) % 7 === 0 ? null : 850 + ((i * 17 + j * 97 + side * 223) % 900),
      change: (i + j) % 9 === 0 ? null : (i % 4 - 2) * 18,
      kda: i % 8 === 0 ? { kills: -1, deaths: 2, assists: 1 } : { kills: (i + j + side) % 22, deaths: (i * 2 + j) % 13, assists: (i + side) % 10 } })) })),
    rounds: i % 9 === 0 ? { a: 0, b: 0 } : { a: i % 12, b: (i * 3 + 1) % 12 }, ...overrides };
}
function run(matches) {
  const child = spawnSync(binary, [], { input: JSON.stringify({ matches }), encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  return JSON.parse(child.stdout);
}
function compare(matches) {
  const expected = [...buildAxisWinProbabilities(matches)];
  assert.deepEqual(run(matches), { version: AXIS_PREDICTION_VERSION, predictions: expected });
  return expected;
}

test("real TS parity across calibration refits and the 1000-observation window", () => {
  const matches = Array.from({ length: 1800 }, (_, i) => match(i, { winner: i % 7 === 0 ? -2 : i % 3 === 0 ? 1 : 0 }));
  for (let i = 0; i < matches.length; i += 67) { matches[i].time += 400 * day; matches[i].queueId = "other"; }
  compare(matches.reverse());
});

test("real TS parity for invalid rosters, repeated match numbers, time batches and queue keys", () => {
  const matches = Array.from({ length: 160 }, (_, i) => match(i));
  matches.push(match(201, { number: 4, time: matches[10].time }), match(202, { number: 4, time: matches[120].time }),
    match(203, { time: null }), match(204, { time: 0 }), match(205, { queueId: null, queue: "league" }),
    match(206, { queueId: null, queue: null }), match(207, { queueId: "" }));
  for (const m of [match(208), match(209), match(210), match(211), match(212)]) {
    if (m.number === 209) m.teams = [];
    if (m.number === 210) m.teams[0].players = [];
    if (m.number === 211) m.teams[0].players[0].id = m.teams[1].players[0].id;
    if (m.number === 212) m.teams[0].players[0].id = "not-an-id";
    if (m.number === 213) m.teams[0].players[0].id = "123456789012345678901";
    matches.push(m);
  }
  compare(matches);
});

test("future, same-time, target statistics, queue isolation and side symmetry", () => {
  const history = Array.from({ length: 180 }, (_, i) => match(i, { winner: i % 4 ? 0 : 1 }));
  const target = match(500, { number: 5000, time: history.at(-1).time + day });
  const baseline = new Map(compare([...history, target])).get(target.number).a;
  const edited = structuredClone(target); edited.winner = 1; edited.rounds = { a: 0, b: 1000 };
  edited.teams.forEach(t => t.players.forEach(p => { p.change = 5000; p.kda = { kills: 999, deaths: 0, assists: 999 }; }));
  const concurrent = match(501, { time: target.time, winner: 1 });
  const future = match(502, { time: target.time + day, winner: 1 });
  assert.equal(new Map(compare([...history, edited, concurrent, future])).get(target.number).a, baseline);
  const swapped = structuredClone(target); swapped.teams.reverse();
  const reverse = new Map(compare([...history, swapped])).get(target.number).a;
  assert.equal(Math.round((baseline + reverse) * 1000), 1000);
  const elsewhere = history.map(m => ({ ...m, queueId: "different" }));
  assert.equal(new Map(compare([...elsewhere, target])).get(target.number).a, 0.5);
});

test("CLI rejects malformed input", () => {
  for (const input of ["{", JSON.stringify({ matches: [{}] }), JSON.stringify({ matches: "invalid" })]) {
    const child = spawnSync(binary, [], { input, encoding: "utf8" });
    assert.notEqual(child.status, 0); assert.ok(child.stderr);
  }
});

test("overflowing historic rating preserves the TS error instead of fabricating a probability", () => {
  const first = match(1, { winner: -2, time: 1000 });
  first.teams[0].players.forEach(p => { p.mmr = 1e308; p.change = 1e308; });
  const second = match(2, { time: 2000 });
  second.teams.forEach(t => t.players.forEach(p => { p.mmr = null; }));
  assert.throws(() => buildAxisWinProbabilities([first, second]), /Invalid Axis calibration score/);
  const child = spawnSync(binary, [], { input: JSON.stringify({ matches: [first, second] }), encoding: "utf8" });
  assert.notEqual(child.status, 0); assert.match(child.stderr, /Invalid Axis calibration score/);
});


test("CLI accepts the 8 MiB limit and rejects a larger input", () => {
  const limit = 8 * 1024 * 1024;
  const valid = '{"matches":[]}';
  const input = valid + " ".repeat(limit - Buffer.byteLength(valid));
  const atLimit = spawnSync(binary, [], { input, encoding: "utf8" });
  assert.equal(atLimit.status, 0, atLimit.stderr || atLimit.error?.message);
  assert.deepEqual(JSON.parse(atLimit.stdout), { version: AXIS_PREDICTION_VERSION, predictions: [] });
  const tooLarge = spawnSync(binary, [], { input: input + " ", encoding: "utf8" });
  assert.notEqual(tooLarge.status, 0);
  assert.match(tooLarge.stderr, /input exceeds 8 MiB/);
  assert.equal(tooLarge.stdout, "");
});
