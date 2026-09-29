#!/usr/bin/env node
import { remainingRunBudget } from "./regular-profile-sync-core.mjs";

import { closeSync, existsSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import process from "node:process";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const WARMUP_MODES = ["regular", "pve", "arena", "pvp-season"];

/** Comma-separated mode filter, e.g. LEADERBOARD_WARMUP_MODES=arena or --modes=arena,pve. */
export function parseWarmupModes(value) {
  if (value == null || String(value).trim() === "") return [...WARMUP_MODES];
  const modes = String(value).split(",").map((entry) => entry.trim()).filter(Boolean);
  const unknown = modes.filter((mode) => !WARMUP_MODES.includes(mode));
  if (modes.length === 0 || unknown.length > 0) {
    throw new Error(`expected modes from ${WARMUP_MODES.join(",")}`);
  }
  return [...new Set(modes)].sort((a, b) => WARMUP_MODES.indexOf(a) - WARMUP_MODES.indexOf(b));
}

/** Same two spellings as argValue in the index-sync scripts: --modes=arena and --modes arena. */
function warmupModesArgValue(argv, name, fallback) {
  const prefix = `${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(name);
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--")) {
    return argv[index + 1];
  }
  return fallback;
}

export function warmupModesFromArgs(argv = process.argv.slice(2)) {
  const value = warmupModesArgValue(argv, "--modes", warmupModesArgValue(argv, "--mode", undefined));
  return parseWarmupModes(value ?? process.env.LEADERBOARD_WARMUP_MODES);
}
const { PVP_STATS_PARSER_VERSION: CURRENT_PVP_PARSER, fetchTarkovJson } = await import("../lib/tarkov-api.ts");
const { ARENA_PARSER_VERSION: CURRENT_ARENA_PARSER } = await import("../lib/arena/storage.ts");
const { createTimestampObjectParser, feedCacheSlot, normalizeUpdatedAt } = await import("./regular-profile-sync-core.mjs");

function integer(value, fallback, minimum, maximum) {
  const parsed = value == null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`expected an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function createRequestPacer({ intervalMs = 500, now = Date.now, sleep = (ms) =>
  new Promise((done) => setTimeout(done, ms)) } = {}) {
  let previousStart = null;
  return async () => {
    const waitMs = previousStart === null ? 0 : Math.max(0, previousStart + intervalMs - now());
    if (waitMs > 0) await sleep(waitMs);
    previousStart = now();
    return previousStart;
  };
}

/**
 * `typeof null` is "object" and so is an array, and an array survives a save
 * because JSON.stringify drops the properties a run adds to it. A checkpoint
 * whose state is `null` crashes the first mode read; one whose state is `[]`
 * discards every save without failing. Both must be refused up front.
 */
function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function loadCheckpoint(path) {
  if (!existsSync(path)) return { checkpoint: { version: 1, skipped: {}, modes: {} }, reset: false };
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.warn(`unreadable leaderboard warmup checkpoint at ${path} (${error instanceof Error ? error.message : String(error)}); starting from a fresh checkpoint`);
    return { checkpoint: { version: 1, skipped: {}, modes: {} }, reset: true };
  }
  if (value?.version !== 1 || !isPlainRecord(value.skipped) || !isPlainRecord(value.modes)) {
    throw new Error(`unsupported leaderboard warmup checkpoint: ${path}`);
  }
  return { checkpoint: value, reset: false };
}

/**
 * A checkpoint temp file is created and renamed away back to back, so one that
 * is this old cannot be a write in progress no matter how wide the run window is.
 */
const ORPHANED_TEMP_MIN_AGE_MS = 60_000;

function saveCheckpoint(path, checkpoint) {
  // The write and the rename land together or not at all, so a process killed in
  // between leaves the previous checkpoint readable. The temp file is the only
  // thing such a kill can lose, and the catch below gives it back on a rename
  // that fails for a reason a retry cannot fix (ENOSPC, EIO, a wrong owner).
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ ...checkpoint, updatedAt: Date.now() }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // A write that never created the temp file, or one the sweep already took.
    }
    throw error;
  }
}

/**
 * Drop the temp files a killed process left behind. They are never read, never
 * cleaned by `finally`, and the run that wrote them is gone, so nothing else
 * removes them and the checkpoint volume grows one file per kill.
 *
 * Two guards keep this away from a file that is still in use. This process's own
 * temp file is skipped by pid, and a temp file younger than
 * ORPHANED_TEMP_MIN_AGE_MS is skipped by age, which also covers a peer running
 * against a checkpoint this run does not share a lock with.
 */
function removeOrphanedCheckpointTemps(path) {
  const directory = dirname(path);
  let names;
  try {
    names = readdirSync(directory);
  } catch {
    return; // Nothing to sweep, and a missing directory still fails in saveCheckpoint.
  }
  const prefix = `${basename(path)}.`;
  const cutoff = Date.now() - ORPHANED_TEMP_MIN_AGE_MS;
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
    if (name === `${prefix}${process.pid}.tmp`) continue;
    const temporary = join(directory, name);
    try {
      if (statSync(temporary).mtimeMs > cutoff) continue;
      unlinkSync(temporary);
    } catch {
      // A peer that renamed or removed it first leaves nothing to clean.
    }
  }
}

function skippedKey(candidate) {
  const scope = candidate.mode === "pvp-season" ? candidate.cycleId : "persistent";
  const parserVersion = candidate.mode === "arena" ? CURRENT_ARENA_PARSER : CURRENT_PVP_PARSER;
  return `${candidate.mode}:${scope}:${candidate.aid}:${candidate.sourceVersion}:parser-${parserVersion}`;
}

function validCycleId(value) {
  const cycleId = String(value ?? "").trim();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(cycleId) ? cycleId : null;
}

/** Persistent in-container exclusion. A stale lock is never stolen automatically. */
export function acquireWarmupLock(path) {
  const token = randomUUID();
  let descriptor;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`leaderboard warmup lock exists at ${path}; verify the recorded process before manual removal`);
    }
    throw error;
  }
  writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, token, startedAt: Date.now() })}\n`);
  return () => {
    closeSync(descriptor);
    try {
      const current = JSON.parse(readFileSync(path, "utf8"));
      if (current?.token === token) unlinkSync(path);
    } catch {
      // Preserve a missing, unreadable, or replaced lock for operator review.
    }
  };
}

export async function loadUpdatedVersions(url, options = {}) {
  const request = typeof options === "function" ? options : options.request ?? fetchTarkovJson;
  const maxRetries = typeof options === "function" ? 0 : options.maxRetries ?? 0;
  const timeoutMs = typeof options === "function" ? 30_000 : options.timeoutMs ?? 30_000;
  const sleep = typeof options === "function" ? (ms) => new Promise((done) => setTimeout(done, ms))
    : options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  let lastError;
  let attempts = 0;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    attempts = attempt;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await request(url, { cache: "no-store", signal: controller.signal });
      if (!response.ok) {
        const error = new Error(`warmup updated feed HTTP ${response.status}`);
        error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw error;
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("warmup updated feed has no readable body");
      const versions = new Map();
      const parser = createTimestampObjectParser((aidValue, updatedValue) => {
        const aid = Number(aidValue);
        const updatedAt = normalizeUpdatedAt(updatedValue);
        if (Number.isSafeInteger(aid) && aid > 0 && updatedAt !== null) versions.set(aid, updatedAt);
      });
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        parser.append(decoder.decode(value, { stream: true }));
      }
      parser.finish(decoder.decode());
      return versions;
    } catch (error) {
      lastError = controller.signal.aborted
        ? new Error(`warmup updated feed timed out after ${timeoutMs}ms`, { cause: error })
        : error;
      if (attempt > maxRetries || error?.retryable === false) break;
      await sleep(Math.min(30_000, 1_000 * 2 ** (attempt - 1)));
    } finally {
      clearTimeout(timeout);
    }
  }
  const detail = lastError instanceof Error ? `${lastError.name}: ${lastError.message}` : String(lastError);
  throw new Error(`warmup updated feed failed after ${attempts} attempts: ${detail}`, { cause: lastError });
}

/** Select only rows produced before the current parser, not current-parser rows with genuinely absent metrics. */
export function selectWarmupCandidates(players, cycleId = null, pveVersions = new Map(), modes = WARMUP_MODES, { checkpoint = {}, limitPerMode = Infinity } = {}) {
  const wanted = new Set(modes);
  const candidates = [];
  const counts = new Map();
  const cursor = (mode) => Number(checkpoint.modes?.[mode]?.lastAid) || 0;
  const add = (candidate) => {
    if (checkpoint.skipped?.[skippedKey(candidate)]) return false;
    candidates.push(candidate);
    const count = (counts.get(candidate.mode) ?? 0) + 1;
    counts.set(candidate.mode, count);
    return count >= limitPerMode;
  };
  if (wanted.has("regular")) {
  for (const row of players.prepare(`
    SELECT p.aid,p.profile_updated_at source_version
    FROM players p
    WHERE p.profile_updated_at>0
      AND NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid=p.aid)
      AND COALESCE((SELECT CASE WHEN s.profile_updated_at>=p.profile_updated_at AND json_valid(s.stats_json)
          THEN json_extract(s.stats_json,'$.pvpStatsParserVersion') ELSE 0 END
        FROM progression_scan.progression_snapshots s
        WHERE s.mode='regular' AND s.cycle_id='persistent' AND s.aid=p.aid
        ORDER BY s.profile_updated_at DESC,s.id DESC LIMIT 1),0) < ?
    ORDER BY (p.aid <= ?), p.aid`).iterate(CURRENT_PVP_PARSER, cursor("regular"))) {
    if (add({ mode: "regular", aid: Number(row.aid), sourceVersion: Number(row.source_version) })) break;
  }
  }
  if (wanted.has("pve")) {
  for (const row of players.prepare(`
    SELECT p.aid,p.profile_updated_at source_version
    FROM mode_players p
    WHERE p.mode='pve'
      AND NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid=p.aid)
      AND CASE WHEN json_valid(p.stats_json)
        THEN COALESCE(json_extract(p.stats_json,'$.pvpStatsParserVersion'),0) ELSE 0 END < ?
    ORDER BY (p.aid <= ?), p.aid`).iterate(CURRENT_PVP_PARSER, cursor("pve"))) {
    const aid = Number(row.aid);
    const sourceVersion = Number(row.source_version) || pveVersions.get(aid) || 0;
    if (sourceVersion > 0 && add({ mode: "pve", aid, sourceVersion })) break;
  }
  }
  if (wanted.has("arena")) {
  for (const row of players.prepare(`
    SELECT p.aid,MAX(p.profile_updated_at,COALESCE(s.upstream_version,0)) source_version
    FROM mode_players p
    LEFT JOIN (
      SELECT aid,MAX(upstream_version) upstream_version,COUNT(DISTINCT arena_mode) mode_count,
        MIN(parser_version) parser_version
      FROM arena_mode_stats GROUP BY aid
    ) s ON s.aid=p.aid
    WHERE p.mode='arena' AND p.profile_updated_at>0
      AND NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid=p.aid)
      AND (s.aid IS NULL OR s.mode_count<6 OR s.parser_version<?)
    ORDER BY (p.aid <= ?), p.aid`).iterate(CURRENT_ARENA_PARSER, cursor("arena"))) {
    if (add({ mode: "arena", aid: Number(row.aid), sourceVersion: Number(row.source_version) })) break;
  }
  }
  if (cycleId && wanted.has("pvp-season")) {
    for (const row of players.prepare(`
      SELECT p.aid,p.profile_updated_at source_version
      FROM progression_scan.player_profiles p
      WHERE p.mode='seasonal' AND p.cycle_id=? AND p.profile_updated_at>0
        AND COALESCE(p.pvp_stats_parser_version,0)<?
        AND p.confirmed_banned=0
        AND NOT EXISTS (SELECT 1 FROM progression_scan.excluded_players e WHERE e.aid=p.aid)
        AND NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid=p.aid)
      ORDER BY (p.aid <= ?), p.aid`).iterate(cycleId, CURRENT_PVP_PARSER, cursor("pvp-season"))) {
      if (add({ mode: "pvp-season", aid: Number(row.aid), sourceVersion: Number(row.source_version), cycleId })) break;
    }
  }
  return candidates;
}

function endpointRequest(baseUrl, secret, candidate) {
  const path = candidate.mode === "pve" ? "/api/operator/pve/profile-sync"
    : candidate.mode === "pvp-season" ? "/api/operator/seasonal/profile-sync"
      : "/api/operator/profile-refresh/sync";
  const body = { aid: candidate.aid, expectedUpdatedAt: candidate.sourceVersion };
  if (candidate.mode === "regular" || candidate.mode === "arena") body.mode = candidate.mode;
  if (candidate.mode === "arena") body.schemaVersion = CURRENT_ARENA_PARSER;
  if (candidate.mode === "pvp-season") body.cycleId = candidate.cycleId;
  return {
    url: new URL(path, baseUrl).href,
    init: {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  };
}

function retryable(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

export async function requestCandidate(candidate, options) {
  const request = endpointRequest(options.baseUrl, options.secret, candidate);
  let lastError;
  for (let attempt = 1; attempt <= options.maxRetries + 1; attempt += 1) {
    if (options.shouldStop?.()) return { kind: "stopped", outcome: "signal", attempts: attempt - 1 };
    await options.pace();
    if (options.shouldStop?.()) return { kind: "stopped", outcome: "signal", attempts: attempt - 1 };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await options.fetch(request.url, { ...request.init, signal: controller.signal });
      const text = await response.text();
      let body = {};
      try { body = text ? JSON.parse(text) : {}; } catch {}
      if (response.status === 401 || response.status === 403) {
        throw Object.assign(new Error(`warmup endpoint rejected credentials: HTTP ${response.status}`), { fatal: true });
      }
      if (response.status === 404) return { kind: "skip", outcome: "not_found", attempts: attempt };
      if (response.ok) {
        const outcome = String(body?.state ?? "ok");
        return { kind: outcome === "skipped_before_cutoff" ? "skip" : "completed", outcome, attempts: attempt };
      }
      const error = Object.assign(new Error(`warmup endpoint HTTP ${response.status}`), {
        retryable: retryable(response.status), status: response.status,
      });
      throw error;
    } catch (error) {
      if (error?.fatal) throw error;
      if (controller.signal.aborted) {
        throw new Error("warmup request timed out; stopping to avoid overlapping server-side profile work");
      }
      lastError = error;
      if (attempt > options.maxRetries || error?.retryable === false) break;
      await options.sleep(Math.min(30_000, 1_000 * 2 ** (attempt - 1)));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(lastError instanceof Error ? lastError.message : String(lastError));
}

export async function runWarmup(options) {
  const now = options.now ?? Date.now;
  const startedAt = now();
  // Before this run writes anything: a temp file can only predate it if a killed process left it.
  removeOrphanedCheckpointTemps(options.checkpointPath);
  const { checkpoint, reset: checkpointReset } = loadCheckpoint(options.checkpointPath);
  const modes = options.modes ?? WARMUP_MODES;
  const grouped = Object.fromEntries(modes.map((mode) => [mode, []]));
  for (const candidate of options.candidates) {
    if (!grouped[candidate.mode]) continue;
    grouped[candidate.mode].push(candidate);
  }
  let processed = 0;
  for (const mode of modes) {
    const state = checkpoint.modes[mode] ?? { attempted: 0, completed: 0, skipped: 0 };
    checkpoint.modes[mode] = state;
    for (const candidate of grouped[mode]) {
      if (options.shouldStop?.()) {
        saveCheckpoint(options.checkpointPath, checkpoint);
        return { processed, bounded: false, stopped: true, checkpoint, checkpointReset };
      }
      if (processed >= options.maxProfiles || now() - startedAt >= (options.maxRunMs ?? Infinity)) {
        saveCheckpoint(options.checkpointPath, checkpoint);
        return { processed, bounded: true, stopped: false, checkpoint, checkpointReset };
      }
      if (checkpoint.skipped[skippedKey(candidate)]) continue;
      state.attempted += 1;
      state.lastAid = candidate.aid;
      checkpoint.nextMode = modes[(modes.indexOf(mode) + 1) % modes.length];
      state.completedAt = null;
      saveCheckpoint(options.checkpointPath, checkpoint);
      let result;
      try {
        result = await options.request(candidate);
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error);
        saveCheckpoint(options.checkpointPath, checkpoint);
        throw error;
      }
      if (result.kind === "stopped") {
        state.attempted -= 1;
        saveCheckpoint(options.checkpointPath, checkpoint);
        return { processed, bounded: false, stopped: true, checkpoint, checkpointReset };
      }
      processed += 1;
      state.lastError = null;
      if (result.kind === "completed") state.completed += 1;
      else {
        state.skipped += 1;
        checkpoint.skipped[skippedKey(candidate)] = { outcome: result.outcome, at: Date.now() };
      }
      saveCheckpoint(options.checkpointPath, checkpoint);
    }
    state.completedAt = Date.now();
    saveCheckpoint(options.checkpointPath, checkpoint);
  }
  return { processed, bounded: false, stopped: false, checkpoint, checkpointReset };
}

async function main() {
  const dbPath = process.env.SQLITE_PATH || "/data/players.db";
  const progressionPath = process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db";
  const checkpointPath = process.env.LEADERBOARD_WARMUP_CHECKPOINT || "/data/leaderboard-warmup-state.json";
  const lockPath = process.env.LEADERBOARD_WARMUP_LOCK || "/data/leaderboard-warmup.lock";
  const maxProfiles = integer(process.env.LEADERBOARD_WARMUP_MAX_PROFILES, 100, 1, 100_000);
  const maxRunMs = integer(process.env.LEADERBOARD_WARMUP_MAX_RUN_MS, 180_000, 1_000, 900_000);
  const maxRetries = integer(process.env.LEADERBOARD_WARMUP_MAX_RETRIES, 3, 0, 10);
  const timeoutMs = integer(process.env.LEADERBOARD_WARMUP_TIMEOUT_MS, 120_000, 30_000, 300_000);
  const secret = process.env.PROFILE_REFRESH_SECRET || "";
  if (secret.length < 32) throw new Error("PROFILE_REFRESH_SECRET must contain at least 32 characters");
  if (!existsSync(dbPath) || !existsSync(progressionPath)) throw new Error("warmup source database is missing");
  const releaseLock = acquireWarmupLock(lockPath);
  let players;
  let stopping = false;
  process.once("SIGINT", () => { stopping = true; });
  process.once("SIGTERM", () => { stopping = true; });
  try {
    const { checkpoint } = loadCheckpoint(checkpointPath);
    const requestedModes = warmupModesFromArgs();
    const pivot = Math.max(0, requestedModes.indexOf(checkpoint.nextMode));
    const modes = [...requestedModes.slice(pivot), ...requestedModes.slice(0, pivot)];
    players = new DatabaseSync(dbPath, { readOnly: true });
    players.prepare("ATTACH DATABASE ? AS progression_scan").run(progressionPath);
    const cycleId = validCycleId(process.env.SEASONAL_CYCLE_ID);
    const needsPveVersions = modes.includes("pve") && players.prepare(`SELECT 1 FROM mode_players p
      WHERE p.mode = 'pve' AND p.profile_updated_at <= 0
        AND NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = p.aid)
        AND CASE WHEN json_valid(p.stats_json) THEN COALESCE(json_extract(p.stats_json, '$.pvpStatsParserVersion'), 0) ELSE 0 END < ?
      LIMIT 1`).get(CURRENT_PVP_PARSER);
    const pveVersions = !needsPveVersions ? new Map() : await (async () => {
      const pveUpdatedUrl = new URL(process.env.PVE_PROFILE_UPDATED_URL || "https://players.tarkov.dev/pve/updated.json");
      pveUpdatedUrl.searchParams.set("v", String(feedCacheSlot()));
      return loadUpdatedVersions(pveUpdatedUrl, {
        maxRetries, timeoutMs, sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      });
    })();
    const candidates = selectWarmupCandidates(players, cycleId, pveVersions, modes, {
      checkpoint, limitPerMode: Math.ceil(maxProfiles / modes.length),
    });
    const pace = createRequestPacer({ intervalMs: 1_000 });
    const result = await runWarmup({
      candidates, checkpointPath, maxProfiles,
      maxRunMs: remainingRunBudget(maxRunMs, process.env.PROFILE_QUEUE_DEADLINE_MS), modes,
      request: (candidate) => requestCandidate(candidate, {
        baseUrl: process.env.LEADERBOARD_WARMUP_BASE_URL || process.env.REGULAR_PROFILE_SYNC_BASE_URL || "http://127.0.0.1:3000",
        secret, maxRetries, timeoutMs, pace, fetch, shouldStop: () => stopping,
        sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      }),
      shouldStop: () => stopping,
    });
    process.stdout.write(`${JSON.stringify({
      modes,
      candidates: Object.fromEntries(modes.map((mode) => [mode, candidates.filter((row) => row.mode === mode).length])),
      processed: result.processed, bounded: result.bounded, stopped: result.stopped, checkpointPath,
      // ops/profile-queue.sh keeps stderr out of $log and replays it into the journal as
      // WARMUP_WARN, so a reset is reported both as prose and as this machine-readable flag.
      checkpointReset: result.checkpointReset,
    })}\n`);
  } finally {
    players?.close();
    releaseLock();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
