#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import process from "node:process";
import {
  createTimestampObjectParser,
  feedCacheSlot,
  normalizeUpdatedAt,
  summarizeCoverage,
} from "./regular-profile-sync-core.mjs";

const { fetchTarkovJson } = await import("../lib/tarkov-api.ts");
const { seedPveProgressionBaselines } = await import("../lib/pve-progression-seed-core.ts");

const PVE_FEED_CUTOFF_MS = Date.parse("2025-11-15T00:00:00+03:00");
const runId = randomUUID();
const config = {
  dbPath: process.env.SQLITE_PATH || "/data/players.db",
  progressionDbPath: process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db",
  updatedUrl: process.env.PVE_PROFILE_UPDATED_URL || "https://players.tarkov.dev/pve/updated.json",
  endpoint: new URL(
    "/api/operator/pve/profile-sync",
    process.env.PVE_PROFILE_SYNC_BASE_URL || process.env.REGULAR_PROFILE_SYNC_BASE_URL || "http://127.0.0.1:3000",
  ).href,
  secret: process.env.PROFILE_REFRESH_SECRET || "",
  requestsPerSecond: envNumber("PVE_PROFILE_SYNC_RPS", 2, 0.1, 20),
  maxRetries: envInteger("PVE_PROFILE_SYNC_MAX_RETRIES", 3, 0, 10),
  requestTimeoutMs: envInteger("PVE_PROFILE_SYNC_TIMEOUT_MS", 30_000, 1_000, 300_000),
  maxRunMs: envInteger("PVE_PROFILE_SYNC_MAX_RUN_MS", 12 * 60_000, 60_000, 13 * 60_000),
  leaseMs: envInteger("PVE_PROFILE_SYNC_LEASE_MS", 30 * 60_000, 60_000, 24 * 60 * 60_000),
  overlapMs: envInteger("PVE_PROFILE_SYNC_OVERLAP_MS", 60 * 60_000, 0, 24 * 60 * 60_000),
};

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
  if (leaseHeld) db.prepare("DELETE FROM pve_profile_sync_lease WHERE id = 1 AND owner = ?").run(runId);
  db.close();
});

async function main() {
  const startedAt = Date.now();
  validateConfig();
  attachProgressionDb();
  initSchema();
  acquireLease();
  leaseHeld = true;

  const bootstrapping = normalizeUpdatedAt(getMeta("feed_watermark")) === null;
  const baseline = bootstrapping ? seedBaselines() : { scanned: 0, inserted: 0, skipped: 0 };
  const feed = await loadFeed();
  const processed = await processQueue(startedAt);
  const statuses = Object.fromEntries(
    db.prepare("SELECT status, COUNT(*) AS n FROM pve_profile_sync_queue GROUP BY status")
      .all().map((row) => [String(row.status), Number(row.n)]),
  );
  const coverage = db.prepare(`
    WITH latest AS (
      SELECT aid, MAX(profile_updated_at) AS snapshot_updated_at
      FROM progression_sync.progression_snapshots
      WHERE mode = 'pve' AND cycle_id = 'persistent'
      GROUP BY aid
    )
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN latest.snapshot_updated_at IS NULL THEN 1 ELSE 0 END) AS missing,
      SUM(CASE WHEN latest.snapshot_updated_at IS NOT NULL
        AND latest.snapshot_updated_at < p.profile_updated_at THEN 1 ELSE 0 END) AS lagging,
      SUM(CASE WHEN latest.snapshot_updated_at IS NOT NULL
        AND latest.snapshot_updated_at >= p.profile_updated_at THEN 1 ELSE 0 END) AS current
    FROM mode_players p
    LEFT JOIN excluded_players e ON e.aid = p.aid
    LEFT JOIN latest ON latest.aid = p.aid
    WHERE p.mode = 'pve' AND e.aid IS NULL
  `).get();
  const coverageSummary = summarizeCoverage(coverage.total, coverage.current);
  const summary = {
    ...feed,
    ...processed,
    ...baseline,
    snapshotMissing: Number(coverage.missing) || 0,
    snapshotLagging: Number(coverage.lagging) || 0,
    snapshotCurrent: Number(coverage.current) || 0,
    ...coverageSummary,
    statuses,
    backlog: Number(statuses.pending ?? 0) + Number(statuses.error ?? 0),
    stopped: stopping,
    durationMs: Date.now() - startedAt,
  };
  saveRunMeta(summary);
  log("SUMMARY", summary);
}

function validateConfig() {
  if (config.secret.length < 32) throw new Error("PROFILE_REFRESH_SECRET must contain at least 32 characters");
  for (const [name, value] of [["PVE_PROFILE_UPDATED_URL", config.updatedUrl], ["sync endpoint", config.endpoint]]) {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) throw new Error(`${name} must use http or https`);
  }
}

function attachProgressionDb() {
  if (!existsSync(config.progressionDbPath)) {
    throw new Error(`progression database not found at ${config.progressionDbPath}; set PROGRESSION_SQLITE_PATH`);
  }
  db.prepare("ATTACH DATABASE ? AS progression_sync").run(config.progressionDbPath);
  const table = db.prepare(`SELECT 1 FROM progression_sync.sqlite_schema
    WHERE type = 'table' AND name = 'progression_snapshots'`).get();
  if (!table) throw new Error("progression_snapshots is missing; initialize the progression schema before running sync");
  const columns = new Set(db.prepare("PRAGMA progression_sync.table_info(progression_snapshots)")
    .all().map((row) => String(row.name)));
  for (const column of ["aid", "mode", "cycle_id", "profile_updated_at"]) {
    if (!columns.has(column)) throw new Error(`progression_snapshots.${column} is missing; apply the progression migration first`);
  }
}

function initSchema() {
  const columns = new Set(db.prepare("PRAGMA table_info(mode_players)").all().map((row) => String(row.name)));
  for (const column of ["aid", "mode", "profile_updated_at", "fetched_at", "stats_json", "achievements"]) {
    if (!columns.has(column)) throw new Error(`mode_players.${column} is missing; apply the player-mode migration first`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS pve_profile_sync_queue (
      aid INTEGER PRIMARY KEY,
      feed_updated_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'not_found', 'stale', 'skipped', 'error')),
      attempts INTEGER NOT NULL DEFAULT 0,
      http_status INTEGER,
      error TEXT,
      last_run_id TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pve_profile_sync_queue_status
      ON pve_profile_sync_queue(status, aid);
    CREATE TABLE IF NOT EXISTS pve_profile_sync_lease (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      owner TEXT NOT NULL,
      heartbeat_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pve_profile_sync_meta (
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
      INSERT INTO pve_profile_sync_lease (id, owner, heartbeat_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, heartbeat_at = excluded.heartbeat_at
      WHERE pve_profile_sync_lease.heartbeat_at < ?
    `).run(runId, now, now - config.leaseMs);
    if (Number(result.changes) !== 1) throw new Error("another PvE profile sync is active");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function heartbeat() {
  const result = db.prepare("UPDATE pve_profile_sync_lease SET heartbeat_at = ? WHERE id = 1 AND owner = ?")
    .run(Date.now(), runId);
  if (Number(result.changes) !== 1) throw new Error("PvE profile sync lease was lost");
}

function seedBaselines() {
  const progressionDb = new DatabaseSync(config.progressionDbPath);
  progressionDb.exec("PRAGMA busy_timeout = 30000");
  try {
    return seedPveProgressionBaselines(progressionDb, db);
  } finally {
    progressionDb.close();
  }
}

function isEligibleUnknown(feedUpdatedAt, savedWatermark) {
  return savedWatermark === null || feedUpdatedAt >= Math.max(PVE_FEED_CUTOFF_MS, savedWatermark - config.overlapMs);
}

async function loadFeed() {
  const tracked = new Map();
  const excluded = new Set(db.prepare("SELECT aid FROM excluded_players").all().map((row) => Number(row.aid)));
  for (const row of db.prepare(`
    SELECT p.aid, p.profile_updated_at,
      (SELECT MAX(s.profile_updated_at) FROM progression_sync.progression_snapshots s
       WHERE s.mode = 'pve' AND s.cycle_id = 'persistent' AND s.aid = p.aid) AS snapshot_updated_at
    FROM mode_players p WHERE p.mode = 'pve'
  `).all()) {
    tracked.set(Number(row.aid), {
      snapshotUpdatedAt: row.snapshot_updated_at == null ? null : Number(row.snapshot_updated_at),
      playerUpdatedAt: Number(row.profile_updated_at) || 0,
    });
  }
  const savedWatermark = normalizeUpdatedAt(getMeta("feed_watermark"));
  const { counters, pendingVersions } = await loadFeedWithRetry(feedUrlForRun(), tracked, excluded, savedWatermark);

  db.exec("BEGIN IMMEDIATE");
  try {
    const queuedAt = Date.now();
    const queuedRows = new Map(db.prepare("SELECT aid, feed_updated_at, status FROM pve_profile_sync_queue").all()
      .map((row) => [Number(row.aid), row]));
    const insert = db.prepare(`INSERT INTO pve_profile_sync_queue
      (aid, feed_updated_at, status, attempts, http_status, error, last_run_id, updated_at)
      VALUES (?, ?, 'pending', 0, NULL, NULL, NULL, ?)`);
    const replace = db.prepare(`UPDATE pve_profile_sync_queue SET feed_updated_at = ?, status = 'pending', attempts = 0,
      http_status = NULL, error = NULL, last_run_id = NULL, updated_at = ? WHERE aid = ?`);
    const reopen = db.prepare(`UPDATE pve_profile_sync_queue SET status = 'pending', attempts = 0,
      http_status = NULL, error = NULL, last_run_id = NULL, updated_at = ? WHERE aid = ? AND status = 'completed'`);
    for (const [aid, pending] of pendingVersions) {
      const queued = queuedRows.get(aid);
      let changed = 0;
      if (!queued) changed = Number(insert.run(aid, pending.feedUpdatedAt, queuedAt).changes);
      else if (pending.feedUpdatedAt > Number(queued.feed_updated_at)) changed = Number(replace.run(pending.feedUpdatedAt, queuedAt, aid).changes);
      else if (queued.status === "completed" && (pending.snapshotUpdatedAt ?? latestSnapshotVersion(aid)) < Number(queued.feed_updated_at)) {
        changed = Number(reopen.run(queuedAt, aid).changes);
      }
      counters.queuedVersions += changed;
      if (changed) {
        if (pending.kind === "new") counters.queuedNewProfiles += 1;
        else counters.queuedUpdatedProfiles += 1;
      }
    }
    if (counters.maxFeedUpdatedAt > 0) {
      const watermark = Math.max(savedWatermark ?? 0, counters.maxFeedUpdatedAt);
      setMeta("feed_watermark", String(watermark));
      counters.watermark = watermark;
    } else counters.watermark = savedWatermark;
    setMeta("last_poll_at", String(counters.polledAt));
    setMeta("last_feed_max_updated_at", String(counters.maxFeedUpdatedAt));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  db.prepare(`DELETE FROM pve_profile_sync_queue
    WHERE EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = pve_profile_sync_queue.aid)`).run();
  db.prepare(`UPDATE pve_profile_sync_queue SET status = 'completed', error = NULL, http_status = NULL, updated_at = ?
    WHERE EXISTS (SELECT 1 FROM progression_sync.progression_snapshots s
      WHERE s.mode = 'pve' AND s.cycle_id = 'persistent' AND s.aid = pve_profile_sync_queue.aid
        AND s.profile_updated_at >= pve_profile_sync_queue.feed_updated_at)`).run(Date.now());
  heartbeat();
  return counters;
}

async function processQueue(startedAt) {
  const counters = { attempted: 0, completed: 0, notFound: 0, stale: 0, skipped: 0, errors: 0 };
  const next = db.prepare(`SELECT q.aid, q.feed_updated_at FROM pve_profile_sync_queue q
    WHERE q.status IN ('pending', 'error')
      AND NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = q.aid)
      AND NOT EXISTS (SELECT 1 FROM progression_sync.progression_snapshots s
        WHERE s.mode = 'pve' AND s.cycle_id = 'persistent' AND s.aid = q.aid
          AND s.profile_updated_at >= q.feed_updated_at)
      AND COALESCE(q.last_run_id, '') <> ?
    ORDER BY q.aid LIMIT 1`);
  const update = db.prepare(`UPDATE pve_profile_sync_queue
    SET status = ?, attempts = attempts + ?, http_status = ?, error = ?, last_run_id = ?, updated_at = ?
    WHERE aid = ? AND feed_updated_at = ?`);
  while (!stopping) {
    if (Date.now() - startedAt >= config.maxRunMs) {
      stopping = true;
      break;
    }
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
    else if (result.kind === "stale") counters.stale += 1;
    else if (result.kind === "skipped") counters.skipped += 1;
    else counters.errors += 1;
    update.run(result.kind, result.attempts, result.status, result.error ?? null, runId, Date.now(), aid, expectedUpdatedAt);
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
        body: JSON.stringify({ aid, mode: "pve", expectedUpdatedAt }),
        signal: controller.signal,
      });
      if (response.status === 404) return { kind: "not_found", attempts: attempt, status: 404 };
      if (response.status === 409) return { kind: "stale", attempts: attempt, status: 409 };
      if (response.status === 401 || response.status === 403) {
        const error = new Error(`sync endpoint rejected credentials: HTTP ${response.status}`);
        error.fatal = true;
        throw error;
      }
      if (response.ok) {
        const body = await response.json();
        if (body?.state === "skipped_before_cutoff" || body?.state === "skipped_missing_skill_date") {
          return { kind: "skipped", attempts: attempt, status: response.status, error: body.state };
        }
        const storedUpdatedAt = normalizeUpdatedAt(body?.profileUpdatedAt);
        if (storedUpdatedAt === null || storedUpdatedAt < expectedUpdatedAt) {
          throw retryableError("sync endpoint stored an older PvE profile version", response.status);
        }
        if (latestSnapshotVersion(aid) < expectedUpdatedAt) {
          throw retryableError("sync endpoint did not store the PvE progression snapshot", response.status);
        }
        return { kind: "completed", attempts: attempt, status: response.status };
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
  const error = new Error(message(lastError));
  error.attempts = config.maxRetries + 1;
  error.status = lastError?.status ?? null;
  throw error;
}

function latestSnapshotVersion(aid) {
  const row = db.prepare(`SELECT MAX(profile_updated_at) AS updated_at FROM progression_sync.progression_snapshots
    WHERE mode = 'pve' AND cycle_id = 'persistent' AND aid = ?`).get(aid);
  return Number(row?.updated_at) || 0;
}

async function loadFeedWithRetry(url, tracked, excluded, savedWatermark) {
  let lastError;
  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      const response = await fetchTarkovJson(url, { cache: "no-store", signal: controller.signal });
      if (!response.ok) {
        const error = new Error(`PvE updated feed HTTP ${response.status}`);
        error.retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw error;
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("PvE updated feed response has no readable body");
      const counters = {
        pvePlayers: [...tracked.keys()].filter((aid) => !excluded.has(aid)).length,
        sourceEntries: 0, invalidEntries: 0, beforeFeedCutoff: 0, trackedInFeed: 0, unknownInFeed: 0,
        excluded: 0, upToDate: 0, oldUnknownIgnored: 0, eligible: 0, newProfiles: 0, updatedProfiles: 0,
        queuedVersions: 0, queuedNewProfiles: 0, queuedUpdatedProfiles: 0,
        bootstrapping: savedWatermark === null, previousWatermark: savedWatermark, maxFeedUpdatedAt: 0, polledAt: 0,
      };
      const pendingVersions = new Map();
      const decoder = new TextDecoder();
      const parser = createTimestampObjectParser((aidRaw, updatedRaw) => {
        counters.sourceEntries += 1;
        const aid = Number(aidRaw);
        const feedUpdatedAt = normalizeUpdatedAt(updatedRaw);
        if (!Number.isSafeInteger(aid) || aid <= 0 || feedUpdatedAt === null) {
          counters.invalidEntries += 1;
          return;
        }
        counters.maxFeedUpdatedAt = Math.max(counters.maxFeedUpdatedAt, feedUpdatedAt);
        // The cutoff is inclusive: updated exactly at Moscow midnight is eligible.
        if (feedUpdatedAt < PVE_FEED_CUTOFF_MS) {
          counters.beforeFeedCutoff += 1;
          return;
        }
        const current = tracked.get(aid);
        if (current === undefined) counters.unknownInFeed += 1;
        else counters.trackedInFeed += 1;
        if (excluded.has(aid)) {
          counters.excluded += 1;
          return;
        }
        if (current !== undefined && feedUpdatedAt <= (current.snapshotUpdatedAt ?? 0)) {
          counters.upToDate += 1;
          return;
        }
        if (current === undefined && !isEligibleUnknown(feedUpdatedAt, savedWatermark)) {
          counters.oldUnknownIgnored += 1;
          return;
        }
        counters.eligible += 1;
        const kind = current === undefined ? "new" : "updated";
        if (kind === "new") counters.newProfiles += 1;
        else counters.updatedProfiles += 1;
        const pending = pendingVersions.get(aid);
        if (!pending || feedUpdatedAt > pending.feedUpdatedAt) {
          pendingVersions.set(aid, { feedUpdatedAt, kind, snapshotUpdatedAt: current?.snapshotUpdatedAt ?? null });
        }
      });
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        parser.append(decoder.decode(value, { stream: true }));
      }
      parser.finish(decoder.decode());
      counters.polledAt = Date.now();
      return { counters, pendingVersions };
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
  url.searchParams.set("v", String(feedCacheSlot()));
  return url.href;
}

function getMeta(key) {
  return db.prepare("SELECT value FROM pve_profile_sync_meta WHERE key = ?").get(key)?.value ?? null;
}

function setMeta(key, value) {
  db.prepare("INSERT INTO pve_profile_sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, String(value));
}

function saveRunMeta(summary) {
  const values = {
    last_poll_at: summary.polledAt,
    last_feed_max_updated_at: summary.maxFeedUpdatedAt,
    last_backlog: summary.backlog,
    last_new_profiles: summary.queuedNewProfiles,
    last_updated_profiles: summary.queuedUpdatedProfiles,
    last_errors: summary.errors,
    last_stale: summary.stale,
    last_skipped: summary.skipped,
    last_seeded_baselines: summary.inserted,
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

function backoff(attempt) { return Math.min(30_000, 1000 * 2 ** (attempt - 1)); }
function envInteger(name, fallback, minimum, maximum) {
  const value = process.env[name] == null || process.env[name] === "" ? fallback : Number(process.env[name]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return value;
}
function envNumber(name, fallback, minimum, maximum) {
  const value = process.env[name] == null || process.env[name] === "" ? fallback : Number(process.env[name]);
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  return value;
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function message(error) { return error instanceof Error ? error.message : String(error); }
function log(event, fields = {}) { process.stdout.write(`${new Date().toISOString()} ${event} ${JSON.stringify(fields)}\n`); }
