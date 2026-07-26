#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import process from "node:process";
import { createTimestampObjectParser, normalizeUpdatedAt } from "./regular-profile-sync-core.mjs";

const config = {
  dbPath: process.env.SQLITE_PATH || "/data/players.db",
  updatedUrl: process.env.REGULAR_PROFILE_UPDATED_URL || "https://players.tarkov.dev/profile/updated.json",
  endpoint: new URL(
    "/api/operator/profile-refresh/sync",
    process.env.REGULAR_PROFILE_SYNC_BASE_URL || "http://127.0.0.1:3000"
  ).href,
  secret: process.env.PROFILE_REFRESH_SECRET || "",
  requestsPerSecond: envNumber("REGULAR_PROFILE_SYNC_RPS", 2, 0.1, 20),
  maxRetries: envInteger("REGULAR_PROFILE_SYNC_MAX_RETRIES", 3, 0, 10),
  requestTimeoutMs: envInteger("REGULAR_PROFILE_SYNC_TIMEOUT_MS", 30_000, 1_000, 300_000),
  leaseMs: envInteger("REGULAR_PROFILE_SYNC_LEASE_MS", 30 * 60_000, 60_000, 24 * 60 * 60_000),
};

const runId = randomUUID();
const db = new DatabaseSync(config.dbPath);
db.exec("PRAGMA busy_timeout = 30000");
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");

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
    db.prepare("DELETE FROM regular_profile_sync_lease WHERE id = 1 AND owner = ?").run(runId);
  }
  db.close();
});

async function main() {
  validateConfig();
  initSchema();
  acquireLease();
  leaseHeld = true;

  log("START", {
    runId,
    db: config.dbPath,
    updatedUrl: config.updatedUrl,
    requestsPerSecond: config.requestsPerSecond,
  });

  const feed = await loadFeed();
  const processed = await processQueue();
  const statuses = Object.fromEntries(
    db.prepare("SELECT status, COUNT(*) AS n FROM regular_profile_sync_queue GROUP BY status")
      .all().map((row) => [String(row.status), Number(row.n)])
  );
  const coverage = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN p.profile_updated_at > 0 THEN 1 ELSE 0 END) AS covered
    FROM players p LEFT JOIN excluded_players e ON e.aid = p.aid
    WHERE e.aid IS NULL
  `).get();
  const coverageTotal = Number(coverage.total);
  const covered = Number(coverage.covered) || 0;
  const trackedNonExcludedInFeed = feed.trackedInFeed - feed.excluded;
  const summary = {
    ...feed,
    ...processed,
    missingFromFeed: Math.max(0, coverageTotal - trackedNonExcludedInFeed),
    covered,
    coveragePercent: coverageTotal > 0 ? Number(((covered / coverageTotal) * 100).toFixed(2)) : 100,
    statuses,
    stopped: stopping,
  };
  db.prepare(
    "INSERT INTO regular_profile_sync_meta (key, value) VALUES ('last_summary', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(JSON.stringify({ at: Date.now(), ...summary }));
  log("SUMMARY", summary);
}

function validateConfig() {
  if (config.secret.length < 32) throw new Error("PROFILE_REFRESH_SECRET must contain at least 32 characters");
  for (const [name, value] of [["REGULAR_PROFILE_UPDATED_URL", config.updatedUrl], ["sync endpoint", config.endpoint]]) {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) throw new Error(`${name} must use http or https`);
  }
}

function initSchema() {
  const playerColumns = db.prepare("PRAGMA table_info(players)").all().map((row) => String(row.name));
  if (!playerColumns.includes("profile_updated_at")) {
    throw new Error("players.profile_updated_at is missing; apply the profile-version migration first");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS regular_profile_sync_queue (
      aid INTEGER PRIMARY KEY,
      feed_updated_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'not_found', 'error')),
      attempts INTEGER NOT NULL DEFAULT 0,
      http_status INTEGER,
      error TEXT,
      last_run_id TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_regular_profile_sync_queue_status
      ON regular_profile_sync_queue(status, aid);
    CREATE TABLE IF NOT EXISTS regular_profile_sync_lease (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      owner TEXT NOT NULL,
      heartbeat_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS regular_profile_sync_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function acquireLease() {
  const now = Date.now();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db.prepare(`
      INSERT INTO regular_profile_sync_lease (id, owner, heartbeat_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, heartbeat_at = excluded.heartbeat_at
      WHERE regular_profile_sync_lease.heartbeat_at < ?
    `).run(runId, now, now - config.leaseMs);
    if (Number(result.changes) !== 1) throw new Error("another regular profile sync is active");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function heartbeat() {
  const result = db.prepare(
    "UPDATE regular_profile_sync_lease SET heartbeat_at = ? WHERE id = 1 AND owner = ?"
  ).run(Date.now(), runId);
  if (Number(result.changes) !== 1) throw new Error("regular profile sync lease was lost");
}

async function loadFeed() {
  const tracked = new Map();
  const excluded = new Set();
  for (const row of db.prepare(`
    SELECT p.aid, p.profile_updated_at, e.aid AS excluded_aid
    FROM players p LEFT JOIN excluded_players e ON e.aid = p.aid
  `).all()) {
    const aid = Number(row.aid);
    tracked.set(aid, Number(row.profile_updated_at) || 0);
    if (row.excluded_aid != null) excluded.add(aid);
  }

  const counters = {
    regularPlayers: tracked.size - excluded.size,
    sourceEntries: 0,
    invalidEntries: 0,
    trackedInFeed: 0,
    excluded: 0,
    upToDate: 0,
    eligible: 0,
    queuedVersions: 0,
  };
  const pendingVersions = [];
  const upsert = db.prepare(`
    INSERT INTO regular_profile_sync_queue
      (aid, feed_updated_at, status, attempts, http_status, error, last_run_id, updated_at)
    VALUES (?, ?, 'pending', 0, NULL, NULL, NULL, ?)
    ON CONFLICT(aid) DO UPDATE SET
      feed_updated_at = excluded.feed_updated_at, status = 'pending', attempts = 0,
      http_status = NULL, error = NULL, last_run_id = NULL, updated_at = excluded.updated_at
    WHERE excluded.feed_updated_at > regular_profile_sync_queue.feed_updated_at
  `);

  const response = await requestWithRetry(feedUrlForRun(), {
    headers: {
      accept: "application/json",
      "user-agent": "TarkovStats/0.1 (+https://tarkovstats.ru)",
    },
  });
  const reader = response.body?.getReader();
  if (!reader) throw new Error("updated feed response has no readable body");
  const decoder = new TextDecoder();
  const parser = createTimestampObjectParser((aidValue, timestampValue) => {
    counters.sourceEntries += 1;
    const aid = Number(aidValue);
    const feedUpdatedAt = normalizeUpdatedAt(timestampValue);
    if (!Number.isSafeInteger(aid) || aid <= 0 || feedUpdatedAt === null) {
      counters.invalidEntries += 1;
      return;
    }
    const savedUpdatedAt = tracked.get(aid);
    if (savedUpdatedAt === undefined) return;
    counters.trackedInFeed += 1;
    if (excluded.has(aid)) {
      counters.excluded += 1;
    } else if (feedUpdatedAt <= savedUpdatedAt) {
      counters.upToDate += 1;
    } else {
      counters.eligible += 1;
      pendingVersions.push([aid, feedUpdatedAt]);
    }
  });

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parser.append(decoder.decode(value, { stream: true }));
  }
  parser.finish(decoder.decode());

  db.exec("BEGIN IMMEDIATE");
  try {
    const queuedAt = Date.now();
    for (const [aid, feedUpdatedAt] of pendingVersions) {
      const result = upsert.run(aid, feedUpdatedAt, queuedAt);
      counters.queuedVersions += Number(result.changes);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  db.prepare(`
    DELETE FROM regular_profile_sync_queue
    WHERE NOT EXISTS (SELECT 1 FROM players p WHERE p.aid = regular_profile_sync_queue.aid)
       OR EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = regular_profile_sync_queue.aid)
  `).run();
  db.prepare(`
    UPDATE regular_profile_sync_queue SET status = 'completed', error = NULL, http_status = NULL,
      updated_at = ?
    WHERE EXISTS (
      SELECT 1 FROM players p
      WHERE p.aid = regular_profile_sync_queue.aid
        AND p.profile_updated_at >= regular_profile_sync_queue.feed_updated_at
    )
  `).run(Date.now());
  heartbeat();
  return counters;
}

async function processQueue() {
  const counters = { attempted: 0, completed: 0, notFound: 0, errors: 0 };
  const next = db.prepare(`
    SELECT q.aid, q.feed_updated_at
    FROM regular_profile_sync_queue q
    JOIN players p ON p.aid = q.aid
    LEFT JOIN excluded_players e ON e.aid = q.aid
    WHERE e.aid IS NULL AND q.status IN ('pending', 'error')
      AND q.feed_updated_at > p.profile_updated_at
      AND COALESCE(q.last_run_id, '') <> ?
    ORDER BY q.aid LIMIT 1
  `);
  const update = db.prepare(`
    UPDATE regular_profile_sync_queue
    SET status = ?, attempts = attempts + ?, http_status = ?, error = ?, last_run_id = ?, updated_at = ?
    WHERE aid = ? AND feed_updated_at = ?
  `);

  while (!stopping) {
    const row = next.get(runId);
    if (!row) break;
    const aid = Number(row.aid);
    const expectedUpdatedAt = Number(row.feed_updated_at);
    counters.attempted += 1;
    let result;
    try {
      result = await syncProfile(aid, expectedUpdatedAt);
    } catch (error) {
      if (error?.fatal) throw error;
      result = { kind: "error", attempts: error?.attempts ?? 1, status: error?.status ?? null, error: message(error) };
    }

    if (result.kind === "completed") counters.completed += 1;
    else if (result.kind === "not_found") counters.notFound += 1;
    else counters.errors += 1;
    update.run(
      result.kind,
      result.attempts,
      result.status,
      result.error ?? null,
      runId,
      Date.now(),
      aid,
      expectedUpdatedAt
    );
    heartbeat();
    if (counters.attempted % 100 === 0) log("PROGRESS", counters);
  }
  return counters;
}

async function syncProfile(aid, expectedUpdatedAt) {
  let lastError;
  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt += 1) {
    await rateLimit();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      const response = await fetch(config.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.secret}`,
          "content-type": "application/json",
          "x-profile-refresh-run-id": runId,
        },
        body: JSON.stringify({ aid, expectedUpdatedAt }),
        signal: controller.signal,
      });
      if (response.status === 404) {
        return { kind: "not_found", attempts: attempt, status: 404 };
      }
      if (response.status === 401 || response.status === 403) {
        const error = new Error(`sync endpoint rejected credentials: HTTP ${response.status}`);
        error.fatal = true;
        throw error;
      }
      if (response.ok) {
        const body = await response.json();
        const storedUpdatedAt = normalizeUpdatedAt(body?.profileUpdatedAt);
        if (storedUpdatedAt === null || storedUpdatedAt < expectedUpdatedAt) {
          throw retryableError("sync endpoint stored an older profile version", response.status);
        }
        return { kind: "completed", attempts: attempt, status: response.status };
      }
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      const error = new Error(`sync endpoint HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
      error.status = response.status;
      error.retryable = response.status === 409 || response.status === 425 || response.status === 429 || response.status >= 500;
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
  const error = new Error(message(lastError));
  error.attempts = config.maxRetries + 1;
  error.status = lastError?.status ?? null;
  throw error;
}

async function requestWithRetry(url, init) {
  let lastError;
  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (response.ok) return response;
      const error = new Error(`updated feed HTTP ${response.status}`);
      error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      throw error;
    } catch (error) {
      lastError = error;
      if (attempt > config.maxRetries || error?.retryable === false) break;
      await delay(backoff(attempt));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

function feedUrlForRun() {
  const url = new URL(config.updatedUrl);
  // Stable for the whole UTC day: bypass a stale CDN object without defeating retry caches.
  url.searchParams.set("v", new Date().toISOString().slice(0, 10));
  return url.href;
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

function log(event, fields = {}) {
  process.stdout.write(`${new Date().toISOString()} ${event} ${JSON.stringify(fields)}\n`);
}
