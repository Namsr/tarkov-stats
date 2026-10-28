// Runs only as a mounted driver inside the unmodified production image.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { createAxisLeagueStore } from "/app/lib/admin/axis-league-db.ts";
import { snapshotContainerResources } from "/tmp/axis-resources.mjs";

const backend = process.env.AXIS_PREDICTION_MATERIALIZER;
assert.ok(["typescript", "rust"].includes(backend));
const fixedTime = 1_760_000_000_000;
const matches = Array.from({ length: 1000 }, (_, i) => ({
  number: i + 1, time: fixedTime + Math.floor(i / 2) * 60_000,
  queueId: i % 11 ? "1343726040421367842" : "secondary", queue: "Arena League",
  maps: [i % 3 ? "Skybridge" : "Sawmill"], winner: i % 3 ? 0 : 1,
  teams: [["1", "2"], ["3", "4"]].map((ids, team) => ({ name: null,
    players: ids.map(id => ({ id, name: `Player ${id}`, profile: null,
      mmr: i % 7 ? 1000 + team * 50 : null, change: 10 })) })),
}));
const sha = value => createHash("sha256").update(value).digest("hex");
const binary = "/app/rust/axis-probability/target/release/axis-probability";
const db = new DatabaseSync("/tmp/axis-benchmark.db");
db.exec("PRAGMA busy_timeout = 5000");
const store = createAxisLeagueStore(db);
const prepare = db.prepare.bind(db);
let replays = 0;
db.prepare = sql => { if (sql === "SELECT * FROM axis_match_kda") replays++; return prepare(sql); };
const tableNames = ["axis_archive_matches", "axis_archive_seasons", "axis_archive_state", "axis_match_participants", "axis_match_predictions", "axis_prediction_state", "axis_preview_state"];
function stateDigest() {
  const rows = Object.fromEntries(tableNames.map(name => [name, prepare(`SELECT * FROM ${name} ORDER BY rowid`).all().map(row => ({ ...row }))]));
  assert.equal(rows.axis_archive_matches.length, 1000);
  assert.equal(rows.axis_match_predictions.length, 1000);
  assert.equal(rows.axis_prediction_state[0].revision, rows.axis_preview_state[0].revision);
  return { digest: sha(JSON.stringify(rows)), revision: rows.axis_preview_state[0].revision,
    predictionRevision: rows.axis_prediction_state[0].revision, cursor: rows.axis_archive_state[0] };
}
const page = list => ({ page: 1, pages: 1, total: 1000, matches: list });
store.publishArchiveBatch([page(matches)], fixedTime);
assert.equal(replays, 1);
const initialState = stateDigest();
const timingsMs = [], states = [];
for (let i = 0; i < 20; i++) {
  const modified = structuredClone(matches[999]); modified.winner = i % 2 ? 1 : 0;
  const started = performance.now();
  store.publishArchiveBatch([page([modified])], fixedTime + i + 1);
  timingsMs.push(performance.now() - started);
  assert.equal(replays, i + 2, "each timed publication must rebuild");
  states.push(stateDigest());
}
db.close();
const resources = snapshotContainerResources();
console.log(JSON.stringify({ formatVersion: 1, backend, rows: 1000, iterations: 20, replays,
  imageId: process.env.BENCHMARK_IMAGE_ID, sourceRevision: process.env.BENCHMARK_SOURCE_REVISION,
  binarySha256: sha(readFileSync(binary)), storeSha256: sha(readFileSync("/app/lib/admin/axis-league-db.ts")),
  materializerSha256: sha(readFileSync("/app/lib/axis-native-probability.ts")),
  tsModelSha256: sha(readFileSync("/app/lib/axis-win-probability.ts")),
  tsCalibrationSha256: sha(readFileSync("/app/lib/axis-probability-calibration.ts")),
  driverSha256: sha(readFileSync("/tmp/axis-driver.mjs")), fixtureSha256: sha(JSON.stringify(matches)),
  initialState, states, timingsMs, resources }));
