import { computeAverage } from "../lib/average-compute.ts";
import { MAX_HISTOGRAM_BINS } from "../lib/histogram.ts";
import { getArenaAverage } from "../lib/arena/service.ts";
import { getSeasonalAverageCrossSectionQuery } from "../lib/seasonal/average-db.ts";
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
let running = false;
let stopping = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const query = await getSeasonalAverageCrossSectionQuery();
  if (!query) throw new Error("seasonal average storage unavailable");
  const payloads = new Map();
  for (const statistic of statistics) {
    for (const period of periods) {
      const result = await query({
        cycleId,
        period,
        statistic,
        dimension: "hours",
        metric: "players",
        min: null,
        max: null,
      });
      if (!result) throw new Error(`seasonal cycle ${cycleId} unavailable`);
      payloads.set(standardAverageVariant(statistic, period), result);
    }
  }
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
    console.warn(`average publication failed (${reason})`, { scope, error: error instanceof Error ? error.message : String(error) });
  }
}

async function runDue(reason, force = false) {
  if (running || stopping) return;
  running = true;
  try {
    const states = new Map((await getAveragePublicationStates()).map((state) => [state.scope, state]));
    for (const scope of scopes()) {
      if (stopping) break;
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
if (!missing) await sleep(30_000);
await runDue("startup");
if (process.env.AVERAGE_MATERIALIZE_ONCE === "true") process.exitCode = 0;
else {
  const timer = setInterval(() => void runDue("scheduled"), pollMs);
  timer.unref?.();
  while (!stopping) await sleep(30_000);
  clearInterval(timer);
}
