import { DatabaseSync } from "node:sqlite";
import { computeAverage } from "../lib/average-compute.ts";
import { MAX_HISTOGRAM_BINS } from "../lib/histogram.ts";
import { getArenaAverage } from "../lib/arena/service.ts";
import { getSeasonalAveragePublicationPayloads } from "../lib/seasonal/average-db.ts";
import {
  averagePublicationDue,
  beginAveragePublication,
  failAveragePublication,
  getAveragePublicationStates,
  publishAverageScope,
  seasonalPublicationScope,
  standardArenaVariant,
  standardAverageVariant,
} from "../lib/average-publication.ts";
import { STANDARD_AVERAGE_PERIODS, STANDARD_AVERAGE_STATISTICS } from "../lib/average-publication-variants.ts";
import { ARENA_MODE_KEYS } from "../types/arena.ts";

const statistics = STANDARD_AVERAGE_STATISTICS;
const periods = STANDARD_AVERAGE_PERIODS;
const arenaModes = ARENA_MODE_KEYS;
const pollMs = 30_000;
const scopePauseMs = 500;
const arenaSyncLeaseMaxAgeMs = 30 * 60_000;
let running = false;
let stopping = false;
// Scopes that failed to publish. Counted instead of thrown so the long-running
// mode can keep retrying on its schedule, while the one-shot mode can report it.
let failedScopes = 0;
let deferred = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function arenaProfileSyncActive(now = Date.now()) {
  let db;
  try {
    db = new DatabaseSync(process.env.SQLITE_PATH || "/data/players.db", { readOnly: true });
    const table = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'arena_profile_sync_lease'"
    ).get();
    if (!table) return false;
    const lease = db.prepare("SELECT heartbeat_at FROM arena_profile_sync_lease WHERE id = 1").get();
    const heartbeatAt = Number(lease?.heartbeat_at);
    const age = now - heartbeatAt;
    return Number.isFinite(heartbeatAt) && age >= 0 && age < arenaSyncLeaseMaxAgeMs;
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

function scopes() {
  const result = ["regular", "pve", "arena"];
  const cycle = process.env.SEASONAL_ENABLED === "true" ? process.env.SEASONAL_CYCLE_ID?.trim() : "";
  if (cycle) result.push(seasonalPublicationScope(cycle));
  return result;
}

async function regularPayloads(mode) {
  const payloads = new Map();
  for (const statistic of statistics) {
    for (const period of periods) {
      const result = await computeAverage(mode, "hours", "players", MAX_HISTOGRAM_BINS, statistic, period, null, null, true);
      if (result.storage !== "sqlite") throw new Error(`${mode} storage unavailable`);
      payloads.set(standardAverageVariant(statistic, period), result.body);
    }
  }
  return payloads;
}

async function seasonalPayloads(scope) {
  const cycleId = scope.slice("seasonal:".length);
  const startedAt = Date.now();
  // Single shared portrait scan for all four standard variants. The previous
  // per-variant cross-section query re-evaluated the latest-snapshot portrait
  // CTE ~38 times per variant (152 scans total), which dominated the ~9 minute
  // production build. The full variant set is still published atomically below.
  const batch = await getSeasonalAveragePublicationPayloads(cycleId);
  if (!batch) throw new Error("seasonal average storage unavailable");
  const { payloads, timings } = batch;
  for (const statistic of statistics) {
    for (const period of periods) {
      if (!payloads.has(standardAverageVariant(statistic, period))) {
        throw new Error(`seasonal cycle ${cycleId} unavailable`);
      }
    }
  }
  console.log("seasonal average variants completed", {
    scope,
    cycleId,
    portraitRows: timings.portraitRows,
    portraitFetchMs: timings.portraitFetchMs,
    variants: timings.variants,
    sqlPhases: { portraitFetchMs: timings.portraitFetchMs },
    totalMs: Date.now() - startedAt,
  });
  return payloads;
}

async function arenaPayloads() {
  const payloads = new Map();
  for (const statistic of statistics) {
    for (const mode of arenaModes) {
      const result = await getArenaAverage({ mode, statistic, dimension: "matches", metric: "players" });
      if (!result) throw new Error("arena storage unavailable");
      payloads.set(standardArenaVariant(mode, statistic), result);
    }
  }
  return payloads;
}

async function materialize(scope, reason) {
  const startedAt = Date.now();
  await beginAveragePublication(scope, startedAt);
  try {
    const payloads = scope === "regular" || scope === "pve"
      ? await regularPayloads(scope)
      : scope === "arena"
        ? await arenaPayloads()
        : await seasonalPayloads(scope);
    const publication = await publishAverageScope(scope, payloads, startedAt);
    console.log(`average publication completed (${reason})`, { scope, ...publication, durationMs: Date.now() - startedAt });
  } catch (error) {
    await failAveragePublication(scope, error);
    failedScopes += 1;
    console.warn(`average publication failed (${reason})`, { scope, error: error instanceof Error ? error.message : String(error) });
  }
}

async function runDue(reason, force = false) {
  if (running || stopping) return;
  if (arenaProfileSyncActive()) {
    deferred = true;
    return;
  }
  running = true;
  try {
    const states = new Map((await getAveragePublicationStates()).map((state) => [state.scope, state]));
    for (const scope of scopes()) {
      if (stopping) break;
      if (arenaProfileSyncActive()) {
        deferred = true;
        break;
      }
      if (force || averagePublicationDue(states.get(scope))) {
        await materialize(scope, reason);
        if (!stopping) await sleep(scopePauseMs);
      }
    }
  } finally {
    running = false;
  }
}

process.once("SIGTERM", () => { stopping = true; });
process.once("SIGINT", () => { stopping = true; });

const initialStates = await getAveragePublicationStates();
const missing = scopes().some((scope) => !initialStates.some((state) => state.scope === scope && state.generation !== null));
if (!missing && process.env.AVERAGE_MATERIALIZE_ONCE !== "true") await sleep(30_000);
await runDue("startup");
// A one-shot run exists to be observed by an operator or CI: a scope that never
// published must fail the run instead of reporting success. The exit code is only
// ever raised, never forced, so a nonzero code set by a failure path survives.
if (process.env.AVERAGE_MATERIALIZE_ONCE === "true") {
  if (failedScopes > 0) process.exitCode = 1;
  else if (deferred) {
    console.warn("average publication deferred: Arena profile sync lease is active");
    process.exitCode = 75;
  }
} else {
  // The long-running mode stays lenient on purpose: runDue retries every failed
  // scope on the next scheduled pass, so a failure must not end the process.
  const timer = setInterval(() => void runDue("scheduled"), pollMs);
  timer.unref?.();
  while (!stopping) await sleep(30_000);
  clearInterval(timer);
}
