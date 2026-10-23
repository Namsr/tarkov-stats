// Synthetic scale test; no production databases, network or known-cheater labels.
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { TEMPO_IDS } from "../lib/achievement-tempo.ts";
import { initializeTempoExclusions, materializeTempo, readTempoReport } from "../lib/achievement-tempo-store.ts";

const count = Number(process.argv[2] ?? 150_000);
if (!Number.isSafeInteger(count) || count < 100 || count > 500_000) throw new Error("Expected 100..500000 profiles");
const directory = mkdtempSync(join(tmpdir(), "tempo-benchmark-"));
let source, output;
try {
  source = new DatabaseSync(join(directory, "source.db"));
  output = new DatabaseSync(join(directory, "tempo.db"));
  source.exec(`CREATE TABLE player_profiles(mode TEXT, cycle_id TEXT, aid INTEGER, confirmed_banned INTEGER, PRIMARY KEY(mode,cycle_id,aid));
    CREATE TABLE excluded_players(aid INTEGER PRIMARY KEY);
    CREATE TABLE progression_personal_revisions(mode TEXT,cycle_id TEXT,aid INTEGER,revision INTEGER,PRIMARY KEY(mode,cycle_id,aid));
    CREATE TABLE progression_snapshots(id INTEGER PRIMARY KEY,mode TEXT,cycle_id TEXT,aid INTEGER,profile_updated_at INTEGER,stats_json TEXT,achievements TEXT);
    CREATE INDEX idx_snapshot ON progression_snapshots(mode,cycle_id,aid,profile_updated_at DESC,id DESC);`);
  const p = source.prepare("INSERT INTO player_profiles VALUES('regular','persistent',?,0)");
  const r = source.prepare("INSERT INTO progression_personal_revisions VALUES('regular','persistent',?,1)");
  const s = source.prepare("INSERT INTO progression_snapshots VALUES(?,'regular','persistent',?,?,?,NULL)");
  const now = Date.parse("2026-10-23T12:00:00Z"), start = Date.parse("2026-06-01T00:00:00Z"), day = 86_400_000;
  source.exec("BEGIN");
  for (let aid = 1; aid <= count; aid++) {
    const times = aid % 10 ? {} : Object.fromEntries(TEMPO_IDS.map((id, i) => [id,
      start + (i < 3 ? i * (1 + aid % 50) : (i - 3) * (1 + aid % 13)) * day]));
    p.run(aid); r.run(aid); s.run(aid, aid, now, JSON.stringify({ achievementUnlocks: times, irrelevant: "x".repeat(1000) }));
  }
  source.exec("COMMIT"); initializeTempoExclusions(source);
  const scope = { mode: "regular", cycleId: "persistent", startsAt: 0, endsAt: null };
  let startTime = performance.now();
  const cold = materializeTempo(source, output, scope, { now });
  const coldMs = performance.now() - startTime;
  startTime = performance.now();
  const repeat = materializeTempo(source, output, scope, { now, force: true });
  const repeatMs = performance.now() - startTime;
  const timings = [];
  for (let i = 0; i < 100; i++) {
    startTime = performance.now(); readTempoReport(source, output, scope, (i + 1) * 10, now);
    timings.push(performance.now() - startTime);
  }
  timings.sort((a, b) => a - b);
  console.log(JSON.stringify({ synthetic: true, profiles: count, coldMs, coldDecoded: cold.decoded,
    repeatMs, repeatDecoded: repeat.decoded, readP50Ms: timings[49], readP95Ms: timings[94],
    outputBytes: statSync(join(directory, "tempo.db")).size, maxRssKiB: process.resourceUsage().maxRSS,
    cohorts: cold.cohorts.map(({ key, n }) => ({ key, n })) }, null, 2));
} finally { output?.close(); source?.close(); rmSync(directory, { recursive: true, force: true }); }
