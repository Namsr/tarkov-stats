import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createAxisLeagueStore } from "../lib/admin/axis-league-db.ts";
import { buildNativeAxisProbabilities } from "../lib/axis-native-probability.ts";

const worker = resolve(`rust/axis-probability/target/debug/axis-probability${process.platform === "win32" ? ".exe" : ""}`);
function match(number) {
  return { number, time: 1_760_000_000_000 + Math.floor(number / 2) * 60_000,
    queueId: number % 9 === 0 ? "other" : "1343726040421367842", queue: "Arena League", maps: ["Skybridge"], winner: number % 3 ? 0 : 1,
    extra: { retained: `match ${number}` }, teams: [["1", "2"], ["3", "4"]].map((ids, team) => ({ name: null, players: ids.map(id => ({ id, name: id, profile: null, mmr: number % 7 ? 1000 + team * 50 : null, change: 10 })) })) };
}
const archive = matches => ({ page: 1, pages: 1, total: matches.length, matches });
function select(backend, binary = worker) { process.env.AXIS_PREDICTION_MATERIALIZER = backend; process.env.AXIS_PREDICTION_BIN = binary; }
function rows(db) {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'axis_%' ORDER BY name").all();
  return Object.fromEntries(names.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all().map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Uint8Array ? [...value] : value])))]));
}

test("native timeout requests a hard kill and propagates the failure", () => {
  const original = childProcess.spawnSync;
  const timeout = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
  let options;
  try {
    childProcess.spawnSync = (_binary, _args, supplied) => { options = supplied; return { status: null, error: timeout }; };
    syncBuiltinESMExports();
    assert.throws(() => buildNativeAxisProbabilities([]), error => error.message === "Axis native prediction worker failed" && error.cause === timeout);
    assert.equal(options.timeout, 30_000);
    assert.equal(options.killSignal, "SIGKILL");
  } finally { childProcess.spawnSync = original; syncBuiltinESMExports(); }
});

test("native materialization matches the actual TS store and rolls back all writer paths on failure", t => {
  const previousBackend = process.env.AXIS_PREDICTION_MATERIALIZER, previousBinary = process.env.AXIS_PREDICTION_BIN, previousOptions = process.env.NODE_OPTIONS;
  const originalNow = Date.now; Date.now = () => 1_760_000_000_000;
  const dir = mkdtempSync(join(tmpdir(), "axis-native-store-"));
  const ts = new DatabaseSync(join(dir, "ts.db")), native = new DatabaseSync(join(dir, "native.db"));
  t.after(() => { Date.now = originalNow; ts.close(); native.close(); rmSync(dir, { recursive: true, force: true });
    if (previousOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previousOptions;
    if (previousBackend === undefined) delete process.env.AXIS_PREDICTION_MATERIALIZER; else process.env.AXIS_PREDICTION_MATERIALIZER = previousBackend;
    if (previousBinary === undefined) delete process.env.AXIS_PREDICTION_BIN; else process.env.AXIS_PREDICTION_BIN = previousBinary; });
  const left = createAxisLeagueStore(ts), right = createAxisLeagueStore(native);
  const games = Array.from({ length: 135 }, (_, i) => match(i + 1));
  games[10].teams[1].players[0].id = "1";
  const both = fn => { select("typescript"); fn(left); select("rust"); fn(right); };
  both(store => store.publishArchiveBatch([archive(games)]));
  assert.deepEqual(rows(native), rows(ts));
  assert.deepEqual(right.readMatchHistory(100), left.readMatchHistory(100));

  // Current and metadata-only imports do not need the child; saved reads are independent of it.
  select("rust", join(dir, "missing"));
  right.publishArchiveBatch([archive(games)]);
  const renamed = structuredClone(games); renamed[0].teams[0].players[0].name = "Updated name";
  right.publishArchiveBatch([archive(renamed)]);
  assert.ok(right.readMatchHistory(100).matches[0].winProbability);
  select("typescript"); left.publishArchiveBatch([archive(games)]); left.publishArchiveBatch([archive(renamed)]);
  assert.deepEqual(rows(native), rows(ts));

  // Missing saved rows keep the existing independent singleton read behavior.
  ts.prepare("DELETE FROM axis_match_predictions WHERE number=135").run();
  native.prepare("DELETE FROM axis_match_predictions WHERE number=135").run();
  select("rust", join(dir, "missing"));
  assert.deepEqual(right.readMatchHistory(135), left.readMatchHistory(135));

  // An unseen external statistics revision must defeat the metadata-only shortcut.
  for (const database of [ts, native]) database.prepare("INSERT INTO axis_match_kda(match_number,discord_id,kills,deaths,assists) VALUES(1,'3',9,2,1)").run();
  const renamedAgain = structuredClone(renamed); renamedAgain[1].teams[0].players[0].name = "Another name";
  const externalBefore = rows(native);
  assert.throws(() => right.publishArchiveBatch([archive(renamedAgain)]), /worker failed/);
  assert.deepEqual(rows(native), externalBefore);
  both(store => store.publishArchiveBatch([archive(renamedAgain)]));
  assert.deepEqual(rows(native), rows(ts));

  const change = [{ discordId: "1", kda: { kills: 25, deaths: 1, assists: 10 }, expected: null }];
  const score = { score: { a: 11, b: 0 }, expected: null };
  let before = rows(native);
  select("rust", join(dir, "missing"));
  assert.throws(() => right.setMatchStats(1, change, score), /worker failed/);
  assert.deepEqual(rows(native), before);
  both(store => store.setMatchStats(1, change, score));
  assert.deepEqual(rows(native), rows(ts));

  const photo = { revision: "a".repeat(64), width: 1, height: 1, data: new Uint8Array([1, 2, 3]) };
  const submission = store => store.submitAxisMatch(2, photo, [{ discordId: "2", kda: { kills: 7, deaths: 3, assists: 2 }, expected: null }], undefined,
    { recognizedNames: [], unmatchedNames: [] }, { sub: "discord_test", name: "Tester", source: "discord" });
  before = rows(native);
  const fake = join(dir, "fake-worker.cjs");
  writeFileSync(fake, "process.exit(23);\n");
  process.env.NODE_OPTIONS = `--require "${fake.replaceAll("\\", "/")}"`;
  select("rust", process.execPath);
  assert.throws(() => submission(right), /worker failed/);
  if (previousOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previousOptions;
  assert.deepEqual(rows(native), before);
  const now = Date.now; Date.now = () => 1_760_000_000_000;
  try { both(submission); } finally { Date.now = now; }
  assert.deepEqual(rows(native), rows(ts));

  before = rows(native);
  select("rust", join(dir, "missing"));
  assert.throws(() => right.publishArchiveBatch([archive([...renamed, match(136)])]), /worker failed/);
  assert.deepEqual(rows(native), before);
  for (const output of [{ version: 99, predictions: [] }, { version: 3, predictions: [] }, { version: 3, predictions: [[1, { a: 0.5, b: 0.5 }], [1, { a: 0.5, b: 0.5 }]] }]) {
    writeFileSync(fake, `process.stdout.write(${JSON.stringify(JSON.stringify(output))}); process.exit(0);`);
    process.env.NODE_OPTIONS = `--require "${fake.replaceAll("\\", "/")}"`; select("rust", process.execPath);
    assert.throws(() => right.publishArchiveBatch([archive([...renamed, match(136)])]), /(?:Invalid|Incomplete) Axis native prediction response/);
    assert.deepEqual(rows(native), before);
  }
  if (previousOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previousOptions;
  both(store => store.publishArchiveBatch([archive([...renamed, match(136)])]));
  assert.deepEqual(rows(native), rows(ts));
  const huge = match(137); huge.maps = ["x".repeat(8 * 1024 * 1024)];
  before = rows(native);
  select("rust");
  assert.throws(() => right.publishArchiveBatch([archive([huge])]), /exceeds 8 MiB/);
  assert.deepEqual(rows(native), before);
});
