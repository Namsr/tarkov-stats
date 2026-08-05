#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import process from "node:process";
import {
  classifySeasonalVersion,
  createTimestampObjectParser,
  normalizeAid,
  normalizeUpdatedAt,
  summarizeSeasonalCoverage,
  seasonalFeedCacheUrl,
} from "./seasonal-profile-sync-core.mjs";

const { fetchTarkovJson } = await import("../lib/tarkov-api.ts");
const { isSeasonalCollectorReady, loadSeasonalCycleConfig, seasonalUpstreamMode } = await import("../lib/seasonal/config.ts");
const { initializeSeasonalSchema } = await import("../lib/seasonal/storage.ts");

const runId = randomUUID();
const feedUrls = {
  updated: (process.env.SEASONAL_PROFILE_UPDATED_URL || "").trim().replaceAll("{mode}", seasonalUpstreamMode()),
};
const config = {
  dbPath: process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db",
  updatedUrl: feedUrls?.updated || "",
  endpoint: new URL(
    "/api/operator/seasonal/profile-sync",
    process.env.SEASONAL_PROFILE_SYNC_BASE_URL || process.env.REGULAR_PROFILE_SYNC_BASE_URL || "http://127.0.0.1:3000",
  ).href,
  secret: process.env.PROFILE_REFRESH_SECRET || "",
  requestsPerSecond: envNumber("SEASONAL_FEED_RPS", 2, 0.1, 20),
  maxRetries: envInteger("SEASONAL_FEED_MAX_RETRIES", 3, 0, 10),
  requestTimeoutMs: envInteger("SEASONAL_FEED_TIMEOUT_MS", 30_000, 1_000, 300_000),
  maxRunMs: envInteger("SEASONAL_FEED_MAX_RUN_MS", 13 * 60_000, 60_000, 24 * 60 * 60_000),
  leaseMs: envInteger("SEASONAL_FEED_LEASE_MS", 30 * 60_000, 60_000, 24 * 60 * 60_000),
};

const cycle = loadSeasonalCycleConfig();
if (!cycle || !isSeasonalCollectorReady()) {
  throw new Error("Seasonal JSON feed is not configured or is not collector-ready");
}
if (config.secret.length < 32) throw new Error("PROFILE_REFRESH_SECRET must contain at least 32 characters");
if (!config.updatedUrl) throw new Error("SEASONAL_PROFILE_UPDATED_URL is required and must be a valid Seasonal feed URL");

const db = new DatabaseSync(config.dbPath);
db.exec("PRAGMA busy_timeout = 30000");
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
initializeSeasonalSchema(db);
initSyncSchema();

let leaseHeld = false;
let stopping = false;
let nextRequestAt = 0;
process.once("SIGINT", () => { stopping = true; });
process.once("SIGTERM", () => { stopping = true; });

main().catch((error) => {
  log("FATAL", { error: message(error) });
  process.exitCode = 1;
}).finally(() => {
  if (leaseHeld) {
    db.prepare("DELETE FROM seasonal_profile_sync_lease WHERE cycle_id = ? AND owner = ?")
      .run(cycle.cycleId, runId);
  }
  db.close();
});

async function main() {
  const startedAt = Date.now();
  acquireLease();
  leaseHeld = true;
  const feed = await loadFeed();
  const processed = await processQueue(startedAt);
  const statuses = Object.fromEntries(
    db.prepare("SELECT status, COUNT(*) AS n FROM seasonal_profile_sync_queue WHERE cycle_id = ? GROUP BY status")
      .all(cycle.cycleId).map((row) => [String(row.status), Number(row.n)]),
  );
  const coverage = summarizeSeasonalCoverage(db, cycle.cycleId);
  const materialization = db.prepare(`
    SELECT generation, materialized_at FROM progression_materializations
    WHERE mode = 'seasonal' AND cycle_id = ?
  `).get(cycle.cycleId) ?? {};
  const backlog = Number(statuses.pending ?? 0) + Number(statuses.error ?? 0);
  const summary = {
    cycleId: cycle.cycleId,
    ...feed,
    ...processed,
    statuses,
    backlog,
    materializationGeneration: materialization.generation == null ? null : Number(materialization.generation),
    materializedAt: materialization.materialized_at == null ? null : Number(materialization.materialized_at),
    ...coverage,
    stopped: stopping,
    durationMs: Date.now() - startedAt,
  };
  saveMeta("last_summary", JSON.stringify({ at: Date.now(), ...summary }));
  for (const [key, value] of Object.entries({
    last_poll_at: feed.polledAt,
    last_feed_max_updated_at: feed.maxFeedUpdatedAt,
    last_backlog: backlog,
    last_completed: processed.completed,
    last_not_found: processed.notFound,
    last_superseded: processed.superseded,
    last_errors: processed.errors,
    last_new_snapshots: processed.newSnapshots,
    last_duration_ms: summary.durationMs,
    last_materialized_at: summary.materializedAt ?? "",
    last_materialization_generation: summary.materializationGeneration ?? "",
    coverage_total: coverage.total,
    coverage_missing: coverage.missing,
    coverage_lagging: coverage.lagging,
    coverage_current: coverage.current,
    coverage_freshness_at: coverage.freshnessAt ?? "",
  })) saveMeta(key, String(value));
  log("SUMMARY", summary);
}

function initSyncSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS seasonal_profile_sync_queue (
      cycle_id TEXT NOT NULL,
      aid INTEGER NOT NULL,
      feed_updated_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'not_found', 'error', 'superseded')),
      attempts INTEGER NOT NULL DEFAULT 0,
      http_status INTEGER,
      error TEXT,
      last_run_id TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (cycle_id, aid, feed_updated_at)
    );
    CREATE INDEX IF NOT EXISTS idx_seasonal_profile_sync_queue_ready
      ON seasonal_profile_sync_queue(cycle_id, status, feed_updated_at, aid);
    CREATE TABLE IF NOT EXISTS seasonal_profile_sync_meta (
      cycle_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (cycle_id, key)
    );
    CREATE TABLE IF NOT EXISTS seasonal_profile_sync_lease (
      cycle_id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      heartbeat_at INTEGER NOT NULL
    );
  `);
}

function acquireLease() {
  const now = Date.now();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db.prepare(`
      INSERT INTO seasonal_profile_sync_lease (cycle_id, owner, heartbeat_at)
      VALUES (?, ?, ?)
      ON CONFLICT(cycle_id) DO UPDATE SET owner = excluded.owner, heartbeat_at = excluded.heartbeat_at
      WHERE seasonal_profile_sync_lease.heartbeat_at < ?
    `).run(cycle.cycleId, runId, now, now - config.leaseMs);
    if (Number(result.changes) !== 1) throw new Error("another Seasonal profile sync is active");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function heartbeat() {
  const result = db.prepare(
    "UPDATE seasonal_profile_sync_lease SET heartbeat_at = ? WHERE cycle_id = ? AND owner = ?",
  ).run(Date.now(), cycle.cycleId, runId);
  if (Number(result.changes) !== 1) throw new Error("Seasonal profile sync lease was lost");
}

async function loadFeed() {
  const counters = {
    sourceEntries: 0,
    invalidEntries: 0,
    excluded: 0,
    queuedVersions: 0,
    preCycleIgnored: 0,
    maxFeedUpdatedAt: 0,
    polledAt: 0,
  };
  const excluded = new Set(db.prepare("SELECT aid FROM excluded_players").all().map((row) => Number(row.aid)));
  const insert = db.prepare(`
    INSERT OR IGNORE INTO seasonal_profile_sync_queue
      (cycle_id, aid, feed_updated_at, status, attempts, updated_at)
    VALUES (?, ?, ?, 'pending', 0, ?)
  `);
  const response = await requestFeed(seasonalFeedCacheUrl(config.updatedUrl));
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Seasonal updated feed has no readable body");
  const decoder = new TextDecoder();
  const parser = createTimestampObjectParser((aidRaw, updatedRaw) => {
    counters.sourceEntries += 1;
    const aid = normalizeAid(aidRaw);
    const updatedAt = normalizeUpdatedAt(updatedRaw);
    if (aid === null || updatedAt === null) {
      counters.invalidEntries += 1;
      return;
    }
    counters.maxFeedUpdatedAt = Math.max(counters.maxFeedUpdatedAt, updatedAt);
    if (updatedAt < cycle.startsAt) {
      counters.preCycleIgnored += 1;
      return;
    }
    if (excluded.has(aid)) {
      counters.excluded += 1;
      return;
    }
    counters.queuedVersions += Number(insert.run(cycle.cycleId, aid, updatedAt, Date.now()).changes);
  });
  db.exec("BEGIN IMMEDIATE");
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.append(decoder.decode(value, { stream: true }));
    }
    parser.finish(decoder.decode());
    counters.polledAt = Date.now();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  saveMeta("feed_watermark", String(counters.maxFeedUpdatedAt || getMeta("feed_watermark") || ""));
  saveMeta("last_poll_at", String(counters.polledAt));
  saveMeta("last_feed_max_updated_at", String(counters.maxFeedUpdatedAt));
  heartbeat();
  return counters;
}

async function requestFeed(url) {
  let lastError;
  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      const response = await fetchTarkovJson(url, { cache: "no-store", signal: controller.signal });
      if (response.ok) return response;
      lastError = new Error(`Seasonal updated feed HTTP ${response.status}`);
      if (![408, 429].includes(response.status) && response.status < 500) break;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
    if (attempt <= config.maxRetries) await delay(backoff(attempt));
  }
  throw lastError ?? new Error("Seasonal updated feed request failed");
}

async function processQueue(startedAt) {
  const counters = { attempted: 0, completed: 0, notFound: 0, superseded: 0, errors: 0, newSnapshots: 0 };
  const next = db.prepare(`
    SELECT aid, feed_updated_at FROM seasonal_profile_sync_queue
    WHERE cycle_id = ? AND status IN ('pending', 'error')
      AND (last_run_id IS NULL OR last_run_id <> ?)
    ORDER BY feed_updated_at, aid LIMIT 1
  `);
  const update = db.prepare(`
    UPDATE seasonal_profile_sync_queue
    SET status = ?, attempts = attempts + ?, http_status = ?, error = ?, last_run_id = ?, updated_at = ?
    WHERE cycle_id = ? AND aid = ? AND feed_updated_at = ?
  `);
  while (!stopping && Date.now() - startedAt < config.maxRunMs) {
    const row = next.get(cycle.cycleId, runId);
    if (!row) break;
    const aid = Number(row.aid);
    const expectedUpdatedAt = Number(row.feed_updated_at);
    counters.attempted += 1;
    const result = await syncProfile(aid, expectedUpdatedAt);
    if (result.kind === "completed") counters.completed += 1;
    else if (result.kind === "not_found") counters.notFound += 1;
    else if (result.kind === "superseded") counters.superseded += 1;
    else counters.errors += 1;
    if (result.snapshotInserted) counters.newSnapshots += 1;
    update.run(result.kind, result.attempts, result.status, result.error ?? null, runId, Date.now(),
      cycle.cycleId, aid, expectedUpdatedAt);
    heartbeat();
    if (counters.attempted % 100 === 0) log("PROGRESS", counters);
  }
  return counters;
}

async function syncProfile(aid, expectedUpdatedAt) {
  let lastError;
  let attempts = 0;
  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt += 1) {
    attempts = attempt;
    await rateLimit();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      const response = await fetch(config.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.secret}`,
          "content-type": "application/json",
          "x-seasonal-profile-sync-run-id": runId,
        },
        body: JSON.stringify({ aid, cycleId: cycle.cycleId, expectedUpdatedAt }),
        signal: controller.signal,
      });
      if (response.status === 404) return { kind: "not_found", attempts: attempt, status: 404, snapshotInserted: false };
      if (response.status === 409) return { kind: "superseded", attempts: attempt, status: 409, snapshotInserted: false };
      if (response.status === 401 || response.status === 403) {
        const error = new Error(`sync endpoint rejected credentials: HTTP ${response.status}`);
        error.fatal = true;
        throw error;
      }
      if (response.ok) {
        const body = await response.json();
        const actual = normalizeUpdatedAt(body?.profileUpdatedAt);
        if (actual === null || actual < expectedUpdatedAt) {
          throw retryableError("sync endpoint stored an older profile version", response.status);
        }
        return {
          kind: classifySeasonalVersion(expectedUpdatedAt, actual) === "current" ? "completed" : "superseded",
          attempts: attempt,
          status: response.status,
          snapshotInserted: body?.capture?.inserted === true,
        };
      }
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      const error = new Error(`sync endpoint HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
      error.status = response.status;
      error.retryable = response.status === 425 || response.status === 429 || response.status >= 500;
      throw error;
    } catch (error) {
      if (error?.fatal) throw error;
      lastError = error;
      if (attempt > config.maxRetries || error?.retryable === false) break;
      await delay(backoff(attempt));
    } finally {
      clearTimeout(timeout);
    }
  }
  return {
    kind: "error",
    attempts,
    status: lastError?.status ?? null,
    error: message(lastError),
    snapshotInserted: false,
  };
}

function getMeta(key) {
  return db.prepare("SELECT value FROM seasonal_profile_sync_meta WHERE cycle_id = ? AND key = ?")
    .get(cycle.cycleId, key)?.value ?? null;
}

function saveMeta(key, value) {
  db.prepare(`
    INSERT INTO seasonal_profile_sync_meta (cycle_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(cycle_id, key) DO UPDATE SET value = excluded.value
  `).run(cycle.cycleId, key, String(value));
}

async function rateLimit() {
  const now = Date.now();
  if (nextRequestAt > now) await delay(nextRequestAt - now);
  nextRequestAt = Math.max(nextRequestAt, Date.now()) + Math.ceil(1000 / config.requestsPerSecond);
}

function retryableError(text, status) {
  const error = new Error(text);
  error.status = status;
  error.retryable = true;
  return error;
}

function backoff(attempt) {
  return Math.min(30_000, 1000 * 2 ** (attempt - 1));
}

function envInteger(name, fallback, minimum, maximum) {
  const value = process.env[name] == null || process.env[name] === "" ? fallback : Number(process.env[name]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function envNumber(name, fallback, minimum, maximum) {
  const value = process.env[name] == null || process.env[name] === "" ? fallback : Number(process.env[name]);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function message(error) { return error instanceof Error ? error.message : String(error); }
function log(event, fields = {}) { process.stdout.write(`${new Date().toISOString()} ${event} ${JSON.stringify(fields)}\n`); }
