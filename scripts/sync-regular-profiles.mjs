#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import process from "node:process";
import {
  classifyFeedEntry,
  createTimestampObjectParser,
  feedCacheSlot,
  normalizeUpdatedAt,
  snapshotTargetVersion,
  summarizeCoverage,
} from "./regular-profile-sync-core.mjs";

const config = {
  dbPath: process.env.SQLITE_PATH || "/data/players.db",
  progressionDbPath: process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db",
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
  overlapMs: envInteger("REGULAR_PROFILE_SYNC_OVERLAP_MS", 60 * 60_000, 0, 24 * 60 * 60_000),
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
  const startedAt = Date.now();
  validateConfig();
  attachProgressionDb();
  initSchema();
  acquireLease();
  leaseHeld = true;

  log("START", {
    runId,
    db: config.dbPath,
    progressionDb: config.progressionDbPath,
    updatedUrl: config.updatedUrl,
    requestsPerSecond: config.requestsPerSecond,
    overlapMs: config.overlapMs,
  });

  const feed = await loadFeed();
  const processed = await processQueue();
  const statuses = Object.fromEntries(
    db.prepare("SELECT status, COUNT(*) AS n FROM regular_profile_sync_queue GROUP BY status")
      .all().map((row) => [String(row.status), Number(row.n)])
  );
  const coverage = db.prepare(`
    WITH latest AS (
      SELECT aid, MAX(profile_updated_at) AS snapshot_updated_at
      FROM progression_sync.progression_snapshots
      WHERE mode = 'regular' AND cycle_id = 'persistent'
      GROUP BY aid
    ), targets AS (
      SELECT p.aid, latest.snapshot_updated_at,
        MAX(COALESCE(p.profile_updated_at, 0), COALESCE(q.feed_updated_at, 0)) AS target_updated_at
      FROM players p
      LEFT JOIN excluded_players e ON e.aid = p.aid
      LEFT JOIN latest ON latest.aid = p.aid
      LEFT JOIN regular_profile_sync_queue q ON q.aid = p.aid
      WHERE e.aid IS NULL
    )
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN snapshot_updated_at IS NULL THEN 1 ELSE 0 END) AS missing,
      SUM(CASE WHEN snapshot_updated_at IS NOT NULL AND snapshot_updated_at < target_updated_at THEN 1 ELSE 0 END) AS lagging,
      SUM(CASE WHEN snapshot_updated_at IS NOT NULL AND snapshot_updated_at >= target_updated_at THEN 1 ELSE 0 END) AS current
    FROM targets
  `).get();
  const snapshotMissing = Number(coverage.missing) || 0;
  const snapshotLagging = Number(coverage.lagging) || 0;
  const snapshotCurrent = Number(coverage.current) || 0;
  const coverageSummary = summarizeCoverage(coverage.total, snapshotCurrent);
  const trackedNonExcludedInFeed = feed.trackedInFeed - feed.trackedExcluded;
  const backlog = Number(statuses.pending ?? 0) + Number(statuses.error ?? 0);
  const summary = {
    ...feed,
    ...processed,
    backlog,
    missingFromFeed: Math.max(0, coverageSummary.coverageTotal - trackedNonExcludedInFeed),
    snapshotMissing,
    snapshotLagging,
    snapshotCurrent,
    ...coverageSummary,
    statuses,
    stopped: stopping,
    durationMs: Date.now() - startedAt,
  };
  saveRunMeta(summary);
  log("SUMMARY", summary);
}

function attachProgressionDb() {
  if (!existsSync(config.progressionDbPath)) {
    throw new Error(`progression database not found at ${config.progressionDbPath}; set PROGRESSION_SQLITE_PATH`);
  }
  db.prepare("ATTACH DATABASE ? AS progression_sync").run(config.progressionDbPath);
  const table = db.prepare(`
    SELECT 1 FROM progression_sync.sqlite_schema
    WHERE type = 'table' AND name = 'progression_snapshots'
  `).get();
  if (!table) throw new Error("progression_snapshots is missing; initialize the progression schema before running sync");
  const columns = new Set(
    db.prepare("PRAGMA progression_sync.table_info(progression_snapshots)").all().map((row) => String(row.name))
  );
  for (const column of ["aid", "mode", "cycle_id", "profile_updated_at"]) {
    if (!columns.has(column)) throw new Error(`progression_snapshots.${column} is missing; apply the progression migration first`);
  }
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
    SELECT p.aid, p.profile_updated_at,
      (SELECT MAX(s.profile_updated_at) FROM progression_sync.progression_snapshots s
       WHERE s.mode = 'regular' AND s.cycle_id = 'persistent' AND s.aid = p.aid) AS snapshot_updated_at
    FROM players p
  `).all()) {
    const aid = Number(row.aid);
    tracked.set(aid, {
      playerUpdatedAt: Number(row.profile_updated_at) || 0,
      snapshotUpdatedAt: row.snapshot_updated_at == null ? null : Number(row.snapshot_updated_at),
    });
  }
  for (const row of db.prepare("SELECT aid FROM excluded_players").all()) excluded.add(Number(row.aid));

  const watermarkRow = db.prepare(
    "SELECT value FROM regular_profile_sync_meta WHERE key = 'feed_watermark'"
  ).get();
  const savedWatermark = normalizeUpdatedAt(watermarkRow?.value);
  const bootstrapping = savedWatermark === null;

  const counters = {
    regularPlayers: [...tracked.keys()].reduce((total, aid) => total + (excluded.has(aid) ? 0 : 1), 0),
    sourceEntries: 0,
    invalidEntries: 0,
    trackedInFeed: 0,
    unknownInFeed: 0,
    excluded: 0,
    trackedExcluded: 0,
    upToDate: 0,
    oldUnknownIgnored: 0,
    bootstrapUnknownIgnored: 0,
    eligible: 0,
    newProfiles: 0,
    updatedProfiles: 0,
    queuedVersions: 0,
    queuedNewProfiles: 0,
    queuedUpdatedProfiles: 0,
    bootstrapping,
    previousWatermark: savedWatermark,
    maxFeedUpdatedAt: 0,
    polledAt: 0,
  };
  const pendingVersions = new Map();
  const insertQueue = db.prepare(`
    INSERT INTO regular_profile_sync_queue
      (aid, feed_updated_at, status, attempts, http_status, error, last_run_id, updated_at)
    VALUES (?, ?, 'pending', 0, NULL, NULL, NULL, ?)
  `);
  const replaceQueueTarget = db.prepare(`
    UPDATE regular_profile_sync_queue SET feed_updated_at = ?, status = 'pending', attempts = 0,
      http_status = NULL, error = NULL, last_run_id = NULL, updated_at = ? WHERE aid = ?
  `);
  const reopenCompleted = db.prepare(`
    UPDATE regular_profile_sync_queue SET status = 'pending', attempts = 0,
      http_status = NULL, error = NULL, last_run_id = NULL, updated_at = ?
    WHERE aid = ? AND status = 'completed'
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
    counters.maxFeedUpdatedAt = Math.max(counters.maxFeedUpdatedAt, feedUpdatedAt);
    const trackedProfile = tracked.get(aid);
    if (trackedProfile === undefined) counters.unknownInFeed += 1;
    else counters.trackedInFeed += 1;
    if (excluded.has(aid)) {
      counters.excluded += 1;
      if (trackedProfile !== undefined) counters.trackedExcluded += 1;
      return;
    }
    if (trackedProfile !== undefined) {
      trackedProfile.feedUpdatedAt = Math.max(trackedProfile.feedUpdatedAt ?? 0, feedUpdatedAt);
    }
    const kind = classifyFeedEntry(
      trackedProfile === undefined ? undefined : (trackedProfile.snapshotUpdatedAt ?? 0),
      feedUpdatedAt,
      savedWatermark,
      config.overlapMs
    );
    if (kind === null && trackedProfile !== undefined) {
      counters.upToDate += 1;
      return;
    }
    if (kind === null) {
      if (bootstrapping) counters.bootstrapUnknownIgnored += 1;
      else counters.oldUnknownIgnored += 1;
      return;
    }
    counters.eligible += 1;
    if (kind === "new") counters.newProfiles += 1;
    else counters.updatedProfiles += 1;
    const pending = pendingVersions.get(aid);
    if (!pending || feedUpdatedAt > pending.feedUpdatedAt) {
      pendingVersions.set(aid, { feedUpdatedAt, kind });
    }
  });

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parser.append(decoder.decode(value, { stream: true }));
  }
  parser.finish(decoder.decode());
  counters.polledAt = Date.now();

  db.exec("BEGIN IMMEDIATE");
  try {
    const queuedAt = Date.now();
    for (const [aid, profile] of tracked) {
      if (excluded.has(aid)) continue;
      const target = snapshotTargetVersion(
        profile.playerUpdatedAt,
        profile.feedUpdatedAt,
        profile.snapshotUpdatedAt
      );
      if (target > (profile.snapshotUpdatedAt ?? 0)) {
        const pending = pendingVersions.get(aid);
        pendingVersions.set(aid, {
          feedUpdatedAt: Math.max(target, pending?.feedUpdatedAt ?? 0),
          kind: pending?.kind ?? "updated",
          snapshotUpdatedAt: profile.snapshotUpdatedAt,
        });
      }
    }
    const queuedRows = new Map(
      db.prepare("SELECT aid, feed_updated_at, status FROM regular_profile_sync_queue").all()
        .map((row) => [Number(row.aid), row])
    );
    for (const [aid, pending] of pendingVersions) {
      const { feedUpdatedAt, kind } = pending;
      const queued = queuedRows.get(aid);
      let changed = 0;
      if (!queued) {
        changed = Number(insertQueue.run(aid, feedUpdatedAt, queuedAt).changes);
      } else if (feedUpdatedAt > Number(queued.feed_updated_at)) {
        changed = Number(replaceQueueTarget.run(feedUpdatedAt, queuedAt, aid).changes);
      } else if (
        queued.status === "completed" &&
        (pending.snapshotUpdatedAt ?? latestSnapshotVersion(aid)) < Number(queued.feed_updated_at)
      ) {
        changed = Number(reopenCompleted.run(queuedAt, aid).changes);
      }
      counters.queuedVersions += changed;
      if (changed === 1) {
        if (kind === "new") counters.queuedNewProfiles += 1;
        else counters.queuedUpdatedProfiles += 1;
      }
    }
    if (counters.maxFeedUpdatedAt > 0) {
      const watermark = Math.max(savedWatermark ?? 0, counters.maxFeedUpdatedAt);
      setMeta("feed_watermark", String(watermark));
      counters.watermark = watermark;
    } else {
      counters.watermark = savedWatermark;
    }
    setMeta("last_poll_at", String(counters.polledAt));
    setMeta("last_feed_max_updated_at", String(counters.maxFeedUpdatedAt));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  db.prepare(`
    DELETE FROM regular_profile_sync_queue
    WHERE EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = regular_profile_sync_queue.aid)
  `).run();
  db.prepare(`
    UPDATE regular_profile_sync_queue SET status = 'completed', error = NULL, http_status = NULL,
      updated_at = ?
    WHERE EXISTS (
      SELECT 1 FROM progression_sync.progression_snapshots s
      WHERE s.mode = 'regular' AND s.cycle_id = 'persistent'
        AND s.aid = regular_profile_sync_queue.aid
        AND s.profile_updated_at >= regular_profile_sync_queue.feed_updated_at
    )
  `).run(Date.now());
  heartbeat();
  return counters;
}

async function processQueue() {
  const counters = { attempted: 0, completed: 0, notFound: 0, errors: 0 };
  const next = db.prepare(`
    SELECT q.aid, q.feed_updated_at FROM regular_profile_sync_queue q
    WHERE q.status IN ('pending', 'error')
      AND NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = q.aid)
      AND NOT EXISTS (
        SELECT 1 FROM progression_sync.progression_snapshots s
        WHERE s.mode = 'regular' AND s.cycle_id = 'persistent' AND s.aid = q.aid
          AND s.profile_updated_at >= q.feed_updated_at
      )
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
        if (latestSnapshotVersion(aid) < expectedUpdatedAt) {
          throw retryableError("sync endpoint did not store the progression snapshot", response.status);
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

function latestSnapshotVersion(aid) {
  const row = db.prepare(`
    SELECT MAX(profile_updated_at) AS updated_at
    FROM progression_sync.progression_snapshots
    WHERE mode = 'regular' AND cycle_id = 'persistent' AND aid = ?
  `).get(aid);
  return Number(row?.updated_at) || 0;
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
  // Stable within each poll window: retries share a CDN object, the next run does not.
  url.searchParams.set("v", String(feedCacheSlot()));
  return url.href;
}

function setMeta(key, value) {
  db.prepare(
    "INSERT INTO regular_profile_sync_meta (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

function saveRunMeta(summary) {
  const values = {
    last_poll_at: summary.polledAt,
    last_feed_max_updated_at: summary.maxFeedUpdatedAt,
    last_backlog: summary.backlog,
    last_new_profiles: summary.queuedNewProfiles,
    last_updated_profiles: summary.queuedUpdatedProfiles,
    last_errors: summary.errors,
    last_duration_ms: summary.durationMs,
    last_summary: JSON.stringify({ at: Date.now(), ...summary }),
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [key, value] of Object.entries(values)) setMeta(key, String(value));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
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
