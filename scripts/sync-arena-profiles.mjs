#!/usr/bin/env node

import { remainingRunBudget } from "./regular-profile-sync-core.mjs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import process from "node:process";
import {
  createTimestampObjectParser,
  feedCacheSlot,
  normalizeUpdatedAt,
  summarizeCoverage,
} from "./regular-profile-sync-core.mjs";
import { syncArenaIndex } from "./sync-arena-index.mjs";

const { fetchTarkovJson, parseArenaProfileStats } = await import("../lib/tarkov-api.ts");
const {
  ARENA_COUNTER_COLUMNS,
  upsertArenaSqlite,
} = await import("../lib/arena/storage.ts");
const { ARENA_MODE_KEYS } = await import("../types/arena.ts");
const { markAveragePublicationDirty } = await import("../lib/average-publication.ts");
// Keep this queue target in lockstep with lib/arena/storage.ts. The collector
// runs under Node's type-strip loader, which cannot resolve the app's @/ alias.
const ARENA_PARSER_VERSION = 4;
const ARENA_V3_PARSER_VERSION = 3;
const ARENA_V3_MIGRATION_KEY = "offline_v3_to_v4_complete";
const ARENA_V3_PUBLICATION_KEY = "offline_v3_to_v4_publication_pending";
const ARENA_DYNAMIC_CACHE_VERSION_KEY = "dynamic_cache_version";
const ARENA_MIGRATION_BATCH_SIZE = 500;
const INDEX_POLL_INTERVAL_MS = 24 * 60 * 60_000;

const runId = randomUUID();
const config = {
  dbPath: process.env.SQLITE_PATH || "/data/players.db",
  updatedUrl: process.env.ARENA_PROFILE_UPDATED_URL || "https://players.tarkov.dev/arena/updated.json",
  indexUrl: process.env.ARENA_PLAYER_INDEX_URL || "https://players.tarkov.dev/arena/index.json",
  endpoint: new URL(
    "/api/operator/profile-refresh/sync",
    process.env.ARENA_PROFILE_SYNC_BASE_URL || process.env.REGULAR_PROFILE_SYNC_BASE_URL || "http://127.0.0.1:3000",
  ).href,
  secret: process.env.PROFILE_REFRESH_SECRET || "",
  requestsPerSecond: envNumber("ARENA_PROFILE_SYNC_RPS", 2, 0.1, 20),
  concurrency: envInteger("ARENA_PROFILE_SYNC_CONCURRENCY", 2, 1, 20),
  maxRetries: envInteger("ARENA_PROFILE_SYNC_MAX_RETRIES", 3, 0, 10),
  requestTimeoutMs: envInteger("ARENA_PROFILE_SYNC_TIMEOUT_MS", 30_000, 1_000, 300_000),
  dbBusyTimeoutMs: envInteger("ARENA_PROFILE_SYNC_DB_BUSY_TIMEOUT_MS", 30_000, 10, 300_000),
  dbBusyRetries: envInteger("ARENA_PROFILE_SYNC_DB_BUSY_RETRIES", 2, 0, 10),
  maxRunMs: envInteger("ARENA_PROFILE_SYNC_MAX_RUN_MS", 25 * 60_000, 60_000, 12 * 60 * 60_000),
  maxCompleted: envOptionalPositiveInteger("ARENA_PROFILE_SYNC_MAX_COMPLETED"),
  progressEvery: envInteger("ARENA_PROFILE_SYNC_PROGRESS_EVERY", 100, 1, 10_000),
  leaseMs: envInteger("ARENA_PROFILE_SYNC_LEASE_MS", 30 * 60_000, 60_000, 24 * 60 * 60_000),
  schemaVersion: ARENA_PARSER_VERSION,
};
config.maxRunMs = remainingRunBudget(config.maxRunMs, process.env.PROFILE_QUEUE_DEADLINE_MS);

const ARENA_UPSTREAM_MODE_KEYS = {
  overall: "UnrankedOverall",
  teamFight: "UnrankedTeamFight",
  lastHero: "UnrankedLastHero",
  checkpoint: "UnrankedCheckPoint",
  blastGang: "UnrankedBlastGang",
  shootOutDuo: "UnrankedShootOutDuo",
};
const ARENA_METRIC_COLUMNS = {
  kd_ratio: "kd_ratio",
  win_rate: "win_rate",
  headshot_rate: "headshot_rate",
  kills_per_match: "kills_per_match",
  damage_per_match: "damage_per_match",
};
const ARENA_MIGRATION_COLUMNS = [
  "aid", "arena_mode", "hours", ...Object.values(ARENA_COUNTER_COLUMNS),
  ...Object.values(ARENA_METRIC_COLUMNS), "best_arp", "upstream_version",
  "parser_version", "raw_json", "fetched_at",
];

const db = new DatabaseSync(config.dbPath);
db.exec(`PRAGMA busy_timeout = ${config.dbBusyTimeoutMs}`);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");

let leaseHeld = false;
let leaseHeartbeatTimer = null;
let stopping = false;
let stopReason = null;
let nextRequestAt = 0;
process.once("SIGINT", () => { stopping = true; stopReason = "signal"; });
process.once("SIGTERM", () => { stopping = true; stopReason = "signal"; });

main().catch((error) => {
  log("FATAL", { error: message(error) });
  process.exitCode = 1;
}).finally(async () => {
  if (leaseHeartbeatTimer) clearInterval(leaseHeartbeatTimer);
  if (leaseHeld) {
    try {
      await withDatabaseBusyRetry(() => db.prepare(
        "DELETE FROM arena_profile_sync_lease WHERE id = 1 AND owner = ?"
      ).run(runId));
    } catch (error) {
      log("LEASE_RELEASE_FAILED", { error: message(error) });
    }
  }
  db.close();
});

async function main() {
  const startedAt = Date.now();
  validateConfig();
  initSchema();
  await acquireLease();
  leaseHeld = true;
  leaseHeartbeatTimer = setInterval(() => {
    void withDatabaseBusyRetry(() => heartbeat()).catch((error) => {
      stopping = true;
      stopReason ??= "lease_error";
      log("HEARTBEAT_FAILED", { error: message(error) });
    });
  }, Math.max(1_000, Math.floor(config.leaseMs / 3)));
  leaseHeartbeatTimer.unref?.();

  const migration = await migrateOfflineArenaV3Profiles(startedAt);
  if (migration.status === "interrupted" || stopping || runBudgetExpired(startedAt)) return;
  const index = await refreshIndexIfDue(startedAt);
  if (stopping || runBudgetExpired(startedAt)) return;
  let feed;
  try {
    feed = await loadFeed(startedAt);
  } catch (error) {
    if (error?.runBudgetExceeded) return;
    throw error;
  }
  if (stopping || runBudgetExpired(startedAt)) return;
  const processed = await processQueue(startedAt);
  const statuses = Object.fromEntries(
    db.prepare("SELECT status, COUNT(*) AS n FROM arena_profile_sync_queue GROUP BY status")
      .all().map((row) => [String(row.status), Number(row.n)]),
  );
  const coverage = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN p.aid IS NULL THEN 1 ELSE 0 END) AS missing,
      SUM(CASE WHEN p.aid IS NOT NULL THEN 1 ELSE 0 END) AS current
    FROM arena_player_index i
    LEFT JOIN excluded_players e ON e.aid = i.aid
    LEFT JOIN (
      SELECT aid FROM arena_mode_stats
      GROUP BY aid
      HAVING COUNT(DISTINCT arena_mode) = 6
        AND SUM(CASE WHEN arena_mode = 'overall' THEN 1 ELSE 0 END) = 1
        AND MIN(parser_version) >= ${config.schemaVersion}
    ) p ON p.aid = i.aid
    WHERE i.mode = 'arena' AND e.aid IS NULL
  `).get();
  const coverageSummary = summarizeCoverage(coverage.total, coverage.current);
  const summary = {
    migration,
    index,
    ...feed,
    ...processed,
    indexMissing: Number(coverage.missing) || 0,
    indexCurrent: Number(coverage.current) || 0,
    ...coverageSummary,
    statuses,
    backlog: Number(statuses.pending ?? 0) + Number(statuses.error ?? 0),
    stopped: stopping,
    stopReason,
    durationMs: Date.now() - startedAt,
  };
  await saveRunMeta(summary);
  log("SUMMARY", summary);
}

async function migrateOfflineArenaV3Profiles(startedAt) {
  if (getMeta(ARENA_V3_MIGRATION_KEY) === "1") {
    return { status: "already_complete", candidates: 0, migrated: 0, network: 0 };
  }
  const currentColumns = new Set(db.prepare("PRAGMA table_info(arena_mode_stats)").all().map((row) => String(row.name)));
  const history = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'arena_mode_stats_history'"
  ).get();
  const historyInfo = history ? db.prepare("PRAGMA table_info(arena_mode_stats_history)").all() : [];
  const historyColumns = new Set(historyInfo.map((row) => String(row.name)));
  const historyPrimaryKey = historyInfo.filter((row) => Number(row.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map((row) => String(row.name)).join(",");
  if (!history || ARENA_MIGRATION_COLUMNS.some((column) => !currentColumns.has(column) || !historyColumns.has(column)) ||
    historyPrimaryKey !== "aid,arena_mode,upstream_version,parser_version") {
    return { status: "unsupported_schema", candidates: 0, migrated: 0, network: 0 };
  }

  const counters = { candidates: 0, migrated: 0, invalid: 0, mixed: 0, stale: 0 };
  const pendingNetwork = [];
  const recoverable = [];
  const processedAids = new Set();
  const selectAids = db.prepare(`SELECT DISTINCT current.aid FROM arena_mode_stats current
    WHERE current.parser_version = ? AND current.aid > ?
      AND NOT EXISTS (SELECT 1 FROM excluded_players excluded WHERE excluded.aid = current.aid)
    ORDER BY current.aid LIMIT ?`);
  let afterAid = 0;
  let complete = false;

  const flush = async () => {
    if (recoverable.length === 0 && pendingNetwork.length === 0) return;
    const recoverableBatch = recoverable.splice(0);
    const networkBatch = pendingNetwork.splice(0);
    const migrated = await writeTransaction(() => {
      assertLeaseHeld();
      const verify = db.prepare(`SELECT COUNT(*) AS n FROM arena_mode_stats
        WHERE aid = ? AND arena_mode = ? AND parser_version = ? AND upstream_version = ?
          AND fetched_at = ? AND raw_json = ?`);
      const enqueue = db.prepare(`INSERT INTO arena_profile_sync_queue
        (aid, feed_updated_at, schema_version, status, attempts, http_status, error, last_run_id, updated_at)
        VALUES (?, ?, ?, 'pending', 0, NULL, NULL, NULL, ?)
        ON CONFLICT(aid) DO UPDATE SET
          feed_updated_at = MAX(arena_profile_sync_queue.feed_updated_at, excluded.feed_updated_at),
          schema_version = MAX(arena_profile_sync_queue.schema_version, excluded.schema_version),
          status = 'pending', attempts = 0, http_status = NULL, error = NULL,
          last_run_id = NULL, updated_at = excluded.updated_at`);
      let accepted = 0;
      for (const item of recoverableBatch) {
        if (item.rows.some((row) => Number(verify.get(
          row.aid, row.arena_mode, ARENA_V3_PARSER_VERSION, row.upstream_version, row.fetched_at, row.raw_json
        ).n) !== 1)) {
          enqueue.run(
            Number(item.profile.aid),
            Math.max(1, ...item.rows.map((row) => Number(row.upstream_version) || 0)),
            ARENA_PARSER_VERSION,
            Date.now()
          );
          continue;
        }
        upsertArenaSqlite(db, item.profile, item.fetchedAt);
        accepted += 1;
      }
      for (const item of networkBatch) {
        enqueue.run(item.aid, item.feedUpdatedAt, ARENA_PARSER_VERSION, Date.now());
      }
      if (accepted > 0) {
        setMeta(ARENA_V3_PUBLICATION_KEY, "1");
        setMeta(ARENA_DYNAMIC_CACHE_VERSION_KEY, String(Number(getMeta(ARENA_DYNAMIC_CACHE_VERSION_KEY) || 0) + 1));
      }
      return accepted;
    });
    counters.migrated += migrated;
    counters.stale += recoverableBatch.length - migrated;
  };

  while (!stopping) {
    if (Date.now() - startedAt >= config.maxRunMs) break;
    const aids = selectAids.all(ARENA_V3_PARSER_VERSION, afterAid, ARENA_MIGRATION_BATCH_SIZE);
    if (aids.length === 0) {
      const remaining = db.prepare(`SELECT DISTINCT current.aid FROM arena_mode_stats current
        WHERE current.parser_version = ?
          AND NOT EXISTS (SELECT 1 FROM excluded_players excluded WHERE excluded.aid = current.aid)`)
        .all(ARENA_V3_PARSER_VERSION);
      if (remaining.some((row) => !processedAids.has(Number(row.aid)))) {
        afterAid = 0;
        continue;
      }
      complete = true;
      break;
    }
    afterAid = Number(aids.at(-1).aid);
    const placeholders = aids.map(() => "?").join(",");
    const rows = db.prepare(`SELECT ${ARENA_MIGRATION_COLUMNS.join(", ")}
      FROM arena_mode_stats WHERE aid IN (${placeholders}) ORDER BY aid, arena_mode`)
      .all(...aids.map((row) => Number(row.aid)));
    const grouped = new Map();
    for (const row of rows) {
      const aid = Number(row.aid);
      const group = grouped.get(aid) ?? [];
      group.push(row);
      grouped.set(aid, group);
    }
    for (const candidate of aids) {
      const aid = Number(candidate.aid);
      processedAids.add(aid);
      const profileRows = grouped.get(aid) ?? [];
      counters.candidates += 1;
      const result = classifyArenaV3Rows(profileRows);
      if (result.kind === "recoverable") {
        recoverable.push({ ...result, rows: profileRows });
      } else {
        if (result.kind === "mixed") counters.mixed += 1;
        else counters.invalid += 1;
        pendingNetwork.push({
          aid,
          feedUpdatedAt: Math.max(1, ...profileRows.map((row) => Number(row.upstream_version) || 0)),
        });
      }
      if (recoverable.length + pendingNetwork.length >= ARENA_MIGRATION_BATCH_SIZE) await flush();
    }
    await heartbeat();
  }
  if (!stopping && !runBudgetExpired(startedAt)) await flush();
  else complete = false;
  const publicationRequired = complete && (counters.migrated > 0 || getMeta(ARENA_V3_PUBLICATION_KEY) === "1");
  if (publicationRequired && await markAveragePublicationDirty("arena") === false) {
    complete = false;
  }
  const summary = {
    status: complete ? "complete" : "interrupted",
    ...counters,
    network: counters.invalid + counters.mixed + counters.stale,
  };
  if (complete) {
    await writeTransaction(() => {
      assertLeaseHeld();
      setMeta(ARENA_V3_MIGRATION_KEY, "1");
      deleteMeta(ARENA_V3_PUBLICATION_KEY);
    });
  }
  log("MIGRATION_SUMMARY", summary);
  return summary;
}

function classifyArenaV3Rows(rows) {
  const expectedModes = new Set(["overall", ...ARENA_MODE_KEYS]);
  if (!Array.isArray(rows) || rows.length !== expectedModes.size) return { kind: "invalid" };
  const byMode = new Map(rows.map((row) => [String(row.arena_mode), row]));
  if (byMode.size !== expectedModes.size || [...expectedModes].some((mode) => !byMode.has(mode))) {
    return { kind: "invalid" };
  }
  if (rows.some((row) => Number(row.parser_version) !== ARENA_V3_PARSER_VERSION)) return { kind: "mixed" };
  const upstreamVersions = new Set(rows.map((row) => Number(row.upstream_version)));
  const fetchedAtValues = new Set(rows.map((row) => Number(row.fetched_at)));
  if (upstreamVersions.size !== 1 || fetchedAtValues.size !== 1) return { kind: "mixed" };
  const upstreamVersion = Number(upstreamVersions.values().next().value);
  const fetchedAt = Number(fetchedAtValues.values().next().value);
  if (!Number.isSafeInteger(upstreamVersion) || upstreamVersion <= 0 ||
    !Number.isSafeInteger(fetchedAt) || fetchedAt <= 0) {
    return { kind: "invalid" };
  }

  const rawByMode = new Map();
  for (const row of rows) {
    let raw;
    try {
      raw = JSON.parse(String(row.raw_json));
    } catch {
      return { kind: "invalid" };
    }
    if (!isRecord(raw) || !Object.hasOwn(raw, "sourceCounters") || !isRecord(raw.normalized)) {
      return { kind: "invalid" };
    }
    if (raw.sourceCounters !== null && !isRecord(raw.sourceCounters)) return { kind: "invalid" };
    if (!storedRowMatchesSnapshot(row, raw.normalized)) return { kind: "invalid" };
    rawByMode.set(String(row.arena_mode), raw);
  }

  const overall = byMode.get("overall");
  const overallHours = overall.hours;
  if (overallHours !== null && (typeof overallHours !== "number" || !Number.isFinite(overallHours) || overallHours < 0)) {
    return { kind: "invalid" };
  }
  for (const mode of ARENA_MODE_KEYS) {
    if (byMode.get(mode).hours !== overallHours) return { kind: "invalid" };
  }

  const aid = Number(overall.aid);
  if (!Number.isSafeInteger(aid) || aid <= 0) return { kind: "invalid" };
  const arenaOverAllCounters = Object.fromEntries(Object.entries(ARENA_UPSTREAM_MODE_KEYS).map(
    ([mode, upstreamKey]) => [upstreamKey, rawByMode.get(mode).sourceCounters]
  ));
  const profile = {
    aid,
    updated: upstreamVersion,
    info: { nickname: "Unknown", side: "Unknown", experience: 0, prestigeLevel: 0 },
    stat: {
      totalInGameTime: overallHours === null ? undefined : overallHours * 3600,
      arenaOverAllCounters,
    },
  };

  let reparsed;
  try {
    reparsed = parseArenaProfileStats(profile).arenaProfile;
  } catch {
    return { kind: "invalid" };
  }
  if (!reparsed || reparsed.parserVersion !== ARENA_PARSER_VERSION ||
    reparsed.profileUpdatedAt !== upstreamVersion) return { kind: "invalid" };
  return { kind: "recoverable", profile: reparsed, fetchedAt };
}

function storedRowMatchesSnapshot(row, snapshot) {
  if (!validStoredSnapshot(snapshot, row.arena_mode)) return false;
  if (!sameNullable(row.hours, snapshot.hours) || !sameNullable(row.best_arp, snapshot.bestArp)) return false;
  for (const [key, column] of Object.entries(ARENA_COUNTER_COLUMNS)) {
    if (!sameNullable(row[column], snapshot.counters?.[key])) return false;
  }
  for (const [key, column] of Object.entries(ARENA_METRIC_COLUMNS)) {
    if (!sameNullable(row[column], snapshot.metrics?.[key])) return false;
  }
  if (row.arena_mode === "overall" && !["upstream", "complete_mode_sum", "unavailable"].includes(snapshot.source)) {
    return false;
  }
  return true;
}

function validStoredSnapshot(snapshot, mode) {
  if (!isRecord(snapshot) || snapshot.mode !== mode ||
    !Object.hasOwn(snapshot, "hours") || !Object.hasOwn(snapshot, "bestArp") ||
    !isRecord(snapshot.counters) || !isRecord(snapshot.metrics)) return false;
  if (Object.keys(ARENA_COUNTER_COLUMNS).some((key) => !Object.hasOwn(snapshot.counters, key))) return false;
  if (Object.keys(ARENA_METRIC_COLUMNS).some((key) => !Object.hasOwn(snapshot.metrics, key))) return false;
  return mode !== "overall" || Object.hasOwn(snapshot, "source");
}

function sameNullable(left, right) {
  return left === right;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateConfig() {
  if (config.secret.length < 32) throw new Error("PROFILE_REFRESH_SECRET must contain at least 32 characters");
  for (const [name, value] of [
    ["ARENA_PROFILE_UPDATED_URL", config.updatedUrl],
    ["ARENA_PLAYER_INDEX_URL", config.indexUrl],
    ["sync endpoint", config.endpoint],
  ]) {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) throw new Error(`${name} must use http or https`);
  }
}

function lastIndexPollAt() {
  const meta = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'arena_player_index_meta'"
  ).get();
  const saved = meta
    ? Number(db.prepare("SELECT value FROM arena_player_index_meta WHERE key = 'last_poll_at'").get()?.value)
    : 0;
  if (Number.isFinite(saved) && saved > 0) return saved;
  return Number(db.prepare(
    "SELECT MAX(synced_at) AS synced_at FROM arena_player_index WHERE mode = 'arena'"
  ).get()?.synced_at) || 0;
}

async function refreshIndexIfDue(startedAt) {
  const previousPollAt = lastIndexPollAt();
  if (previousPollAt > Date.now() - INDEX_POLL_INTERVAL_MS) {
    return { checked: false, previousPollAt };
  }
  try {
    const remainingMs = config.maxRunMs - (Date.now() - startedAt);
    const result = await syncArenaIndex(db, {
      url: config.indexUrl,
      beforeWrite: assertLeaseHeld,
      signal: AbortSignal.timeout(Math.max(1, remainingMs)),
    });
    return { checked: true, previousPollAt, ...result };
  } catch (error) {
    log("INDEX_FAILED", { error: message(error), previousPollAt });
    return { checked: true, previousPollAt, error: message(error) };
  }
}

function initSchema() {
  const columns = new Set(db.prepare("PRAGMA table_info(mode_players)").all().map((row) => String(row.name)));
  for (const column of ["aid", "mode", "profile_updated_at", "fetched_at", "stats_json", "achievements"]) {
    if (!columns.has(column)) throw new Error(`mode_players.${column} is missing; apply the player-mode migration first`);
  }
  const index = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'arena_player_index'`).get();
  if (!index) throw new Error("arena_player_index is missing; run the Arena index sync first");
  db.exec(`
    CREATE TABLE IF NOT EXISTS arena_profile_sync_queue (
      aid INTEGER PRIMARY KEY,
      feed_updated_at INTEGER NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'not_found', 'stale', 'error')),
      attempts INTEGER NOT NULL DEFAULT 0,
      http_status INTEGER,
      error TEXT,
      last_run_id TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_arena_profile_sync_queue_status
      ON arena_profile_sync_queue(status, aid);
    CREATE TABLE IF NOT EXISTS arena_profile_sync_lease (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      owner TEXT NOT NULL,
      heartbeat_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS arena_profile_sync_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const queueColumns = new Set(db.prepare("PRAGMA table_info(arena_profile_sync_queue)").all()
    .map((row) => String(row.name)));
  if (!queueColumns.has("schema_version")) {
    db.exec("ALTER TABLE arena_profile_sync_queue ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 0");
  }
}

async function acquireLease() {
  const now = Date.now();
  const result = await writeTransaction(() => db.prepare(`
      INSERT INTO arena_profile_sync_lease (id, owner, heartbeat_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, heartbeat_at = excluded.heartbeat_at
      WHERE arena_profile_sync_lease.heartbeat_at < ?
    `).run(runId, now, now - config.leaseMs));
  if (Number(result.changes) !== 1) throw new Error("another Arena profile sync is active");
}

async function heartbeat() {
  const result = await withDatabaseBusyRetry(() => db.prepare(
    "UPDATE arena_profile_sync_lease SET heartbeat_at = ? WHERE id = 1 AND owner = ?"
  ).run(Date.now(), runId));
  if (Number(result.changes) !== 1) throw new Error("Arena profile sync lease was lost");
}

function assertLeaseHeld() {
  const lease = db.prepare("SELECT owner, heartbeat_at FROM arena_profile_sync_lease WHERE id = 1").get();
  const age = Date.now() - Number(lease?.heartbeat_at);
  if (lease?.owner !== runId || !Number.isFinite(age) || age < 0 || age > config.leaseMs) {
    throw new Error("Arena profile sync lease was lost");
  }
}

function trackedArenaProfiles() {
  const normalized = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'arena_mode_stats'"
  ).get();
  if (normalized) {
    return new Map(db.prepare(`SELECT aid, MAX(upstream_version) AS upstream_version,
      MIN(parser_version) AS parser_version
      FROM arena_mode_stats
      GROUP BY aid
      HAVING COUNT(DISTINCT arena_mode) = 6
        AND SUM(CASE WHEN arena_mode = 'overall' THEN 1 ELSE 0 END) = 1`).all().map((row) => [Number(row.aid), {
      updatedAt: Number(row.upstream_version) || 0,
      schemaVersion: Number(row.parser_version) || 0,
    }]));
  }
  // Legacy rows have no complete raw Arena counter tree. Treat them as an old
  // parser so the next indexed or feed-discovered profile is fetched again.
  return new Map(db.prepare(`SELECT aid, profile_updated_at FROM mode_players WHERE mode = 'arena'`)
    .all().map((row) => [Number(row.aid), {
      updatedAt: Number(row.profile_updated_at) || 0,
      schemaVersion: 0,
    }]));
}

async function loadFeed(startedAt) {
  const tracked = trackedArenaProfiles();
  const excluded = new Set(db.prepare("SELECT aid FROM excluded_players").all().map((row) => Number(row.aid)));
  let counters;
  let pendingVersions;
  let feed;
  try {
    ({ counters, pendingVersions, feed } = await loadUpdatedFeedWithRetry(feedUrlForRun(), tracked, excluded, startedAt));
  } catch (error) {
    if (error?.runBudgetExceeded) throw error;
    counters = emptyFeedCounters(tracked, error);
    pendingVersions = new Map();
    feed = { notModified: false, etag: null, lastModified: null, failed: true };
    log("FEED_FAILED", { error: message(error) });
  }

  const indexRows = db.prepare(`
    SELECT aid FROM arena_player_index WHERE mode = 'arena'
  `).all();
  for (const row of indexRows) {
    const aid = Number(row.aid);
    if (!Number.isSafeInteger(aid) || aid <= 0 || excluded.has(aid)) continue;
    const snapshot = tracked.get(aid);
    if ((!snapshot || snapshot.updatedAt <= 0 || snapshot.schemaVersion < config.schemaVersion) && !pendingVersions.has(aid)) {
      pendingVersions.set(aid, {
        feedUpdatedAt: Math.max(1, snapshot?.updatedAt ?? 0),
        schemaVersion: config.schemaVersion,
        kind: "index",
        snapshotUpdatedAt: snapshot?.updatedAt ?? null,
      });
      counters.indexProfiles += 1;
    }
  }

  if (runBudgetExpired(startedAt)) throw runBudgetError();
  await writeTransaction(() => {
    const queuedAt = Date.now();
    if (getMeta("verified_not_found_v1") !== "1") {
      counters.requeuedUnverifiedNotFound = Number(db.prepare(`UPDATE arena_profile_sync_queue
        SET status = 'pending', attempts = 0, http_status = NULL, error = NULL,
          last_run_id = NULL, updated_at = ?
        WHERE status = 'not_found'`).run(queuedAt).changes);
      setMeta("verified_not_found_v1", "1");
    }
    const queuedRows = new Map(db.prepare(
      "SELECT aid, feed_updated_at, schema_version, status FROM arena_profile_sync_queue"
    ).all().map((row) => [Number(row.aid), row]));
    const insert = db.prepare(`INSERT INTO arena_profile_sync_queue
      (aid, feed_updated_at, schema_version, status, attempts, http_status, error, last_run_id, updated_at)
      VALUES (?, ?, ?, 'pending', 0, NULL, NULL, NULL, ?)`);
    const replace = db.prepare(`UPDATE arena_profile_sync_queue SET feed_updated_at = ?, schema_version = ?, status = 'pending', attempts = 0,
      http_status = NULL, error = NULL, last_run_id = NULL, updated_at = ? WHERE aid = ?`);
    const reopen = db.prepare(`UPDATE arena_profile_sync_queue SET status = 'pending', attempts = 0,
      http_status = NULL, error = NULL, last_run_id = NULL, updated_at = ? WHERE aid = ?
      AND status IN ('completed', 'stale') AND schema_version <= ?`);
    for (const [aid, pending] of pendingVersions) {
      const queued = queuedRows.get(aid);
      let changed = 0;
      const snapshot = tracked.get(aid);
      if (!queued) changed = Number(insert.run(aid, pending.feedUpdatedAt, pending.schemaVersion, queuedAt).changes);
      else if (pending.feedUpdatedAt > Number(queued.feed_updated_at) ||
        pending.schemaVersion > Number(queued.schema_version)) {
        changed = Number(replace.run(pending.feedUpdatedAt, pending.schemaVersion, queuedAt, aid).changes);
      } else if ((queued.status === "completed" || queued.status === "stale") &&
        ((snapshot?.updatedAt ?? 0) < Number(queued.feed_updated_at) ||
          (snapshot?.schemaVersion ?? 0) < Number(queued.schema_version))) {
        changed = Number(reopen.run(queuedAt, aid, Number(queued.schema_version)).changes);
      }
      counters.queuedVersions += changed;
      if (changed) {
        if (pending.kind === "new" || pending.kind === "index") counters.queuedNewProfiles += 1;
        else counters.queuedUpdatedProfiles += 1;
      }
    }
    if (counters.maxFeedUpdatedAt > 0) {
      setMeta("feed_watermark", String(Math.max(Number(getMeta("feed_watermark")) || 0, counters.maxFeedUpdatedAt)));
    }
    setMeta("last_poll_at", String(counters.polledAt));
    setMeta("last_feed_max_updated_at", String(counters.maxFeedUpdatedAt));
    // Validators are accepted only together with the parsed queue changes in
    // this transaction. A 304 keeps the previously accepted validators; a
    // failed load leaves validators AND source URL untouched so a source
    // change combined with a network failure cannot pin a foreign ETag to the
    // new source. Index-driven candidates above still queue.
    if (!feed || feed.failed) {
      // No accepted representation in this run: leave validators untouched.
    } else {
      setMeta("feed_source_url", config.updatedUrl);
      if (feed.notModified) {
        // Keep the accepted validators; only the 304 poll itself is recorded.
      } else if (feed.etag) {
        setMeta("feed_etag", feed.etag);
      } else {
        deleteMeta("feed_etag");
      }
    }
    if (feed && !feed.notModified && !feed.failed) {
      if (feed.lastModified) setMeta("feed_last_modified", feed.lastModified);
      else deleteMeta("feed_last_modified");
    }
    setMeta("last_feed_http_status", String(counters.feedHttpStatus ?? ""));
  });
  await writeTransaction(() => {
    db.prepare(`DELETE FROM arena_profile_sync_queue
      WHERE EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = arena_profile_sync_queue.aid)`).run();
    db.prepare(`UPDATE arena_profile_sync_queue SET status = 'completed', error = NULL,
        http_status = NULL, updated_at = ?
      WHERE (arena_profile_sync_queue.status <> 'completed'
        OR arena_profile_sync_queue.error IS NOT NULL)
      AND EXISTS (SELECT 1 FROM arena_mode_stats p
        WHERE p.aid = arena_profile_sync_queue.aid
        GROUP BY p.aid
        HAVING COUNT(DISTINCT p.arena_mode) = 6
          AND SUM(CASE WHEN p.arena_mode = 'overall' THEN 1 ELSE 0 END) = 1
          AND SUM(CASE WHEN p.upstream_version >= arena_profile_sync_queue.feed_updated_at THEN 1 ELSE 0 END) = 6
          AND SUM(CASE WHEN p.parser_version >= arena_profile_sync_queue.schema_version THEN 1 ELSE 0 END) = 6)`).run(Date.now());
  });
  await heartbeat();
  return counters;
}

function emptyFeedCounters(tracked, error) {
  return {
    arenaPlayers: tracked.size,
    sourceEntries: 0,
    invalidEntries: 0,
    trackedInFeed: 0,
    unknownInFeed: 0,
    eligible: 0,
    newProfiles: 0,
    updatedProfiles: 0,
    indexProfiles: 0,
    queuedVersions: 0,
    queuedNewProfiles: 0,
    queuedUpdatedProfiles: 0,
    maxFeedUpdatedAt: 0,
    polledAt: Date.now(),
    feedNotModified: false,
    feedHttpStatus: 0,
    feedError: message(error),
    requeuedUnverifiedNotFound: 0,
  };
}

async function processQueue(startedAt) {
  const counters = { attempted: 0, completed: 0, notFound: 0, stale: 0, errors: 0 };
  let admitted = 0;
  let inFlight = 0;
  const next = db.prepare(`SELECT q.aid, q.feed_updated_at, q.schema_version FROM arena_profile_sync_queue q
    WHERE q.status IN ('pending', 'error')
      AND NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = q.aid)
      AND NOT EXISTS (SELECT 1 FROM arena_mode_stats p
        WHERE p.aid = q.aid
        GROUP BY p.aid
        HAVING COUNT(DISTINCT p.arena_mode) = 6
          AND SUM(CASE WHEN p.arena_mode = 'overall' THEN 1 ELSE 0 END) = 1
          AND SUM(CASE WHEN p.upstream_version >= q.feed_updated_at THEN 1 ELSE 0 END) = 6
          AND SUM(CASE WHEN p.parser_version >= q.schema_version THEN 1 ELSE 0 END) = 6)
      AND COALESCE(q.last_run_id, '') <> ?
    ORDER BY q.aid`);
  const claim = db.prepare(`UPDATE arena_profile_sync_queue
    SET last_run_id = ?, updated_at = ?
    WHERE aid = ? AND feed_updated_at = ? AND schema_version = ? AND COALESCE(last_run_id, '') <> ?
      AND EXISTS (SELECT 1 FROM arena_profile_sync_lease
        WHERE id = 1 AND owner = ? AND heartbeat_at >= ?)`);
  const update = db.prepare(`UPDATE arena_profile_sync_queue
    SET status = ?, attempts = attempts + ?, http_status = ?, error = ?, last_run_id = ?, updated_at = ?
    WHERE aid = ? AND feed_updated_at = ? AND schema_version = ? AND last_run_id = ?
      AND EXISTS (SELECT 1 FROM arena_profile_sync_lease
        WHERE id = 1 AND owner = ? AND heartbeat_at >= ?)`);

  async function worker() {
    try {
      while (!stopping) {
        if (runBudgetExpired(startedAt)) {
          stopping = true;
          stopReason = "max_run_ms";
          return;
        }
        while (config.maxCompleted !== null && admitted >= config.maxCompleted && !stopping) {
          if (inFlight === 0) {
            stopping = true;
            stopReason = "max_completed";
            return;
          }
          await delay(10);
        }
        if (stopping) return;
        const row = next.get(runId);
        if (!row) {
          stopReason ??= "queue_exhausted";
          return;
        }
        const aid = Number(row.aid);
        const expectedUpdatedAt = Number(row.feed_updated_at);
        const schemaVersion = Number(row.schema_version);
        admitted += 1;
        inFlight += 1;
        const claimedAt = Date.now();
        const claimed = await withDatabaseBusyRetry(() => claim.run(
          runId, claimedAt, aid, expectedUpdatedAt, schemaVersion, runId,
          runId, claimedAt - config.leaseMs
        ));
        if (Number(claimed.changes) !== 1) {
          admitted -= 1;
          inFlight -= 1;
          assertLeaseHeld();
          continue;
        }
        counters.attempted += 1;
        let result;
        try {
          result = await syncProfile(aid, expectedUpdatedAt, schemaVersion, startedAt);
        } catch (error) {
          if (error?.fatal) throw error;
          result = { kind: "error", attempts: error?.attempts ?? 1, status: error?.status ?? null, error: message(error) };
        }
        if (result === null) {
          inFlight -= 1;
          return;
        }
        const updatedAt = Date.now();
        const updated = await withDatabaseBusyRetry(() => update.run(
          result.kind, result.attempts, result.status, result.error ?? null, runId, updatedAt,
          aid, expectedUpdatedAt, schemaVersion, runId, runId, updatedAt - config.leaseMs
        ));
        inFlight -= 1;
        if (Number(updated.changes) !== 1) {
          admitted -= 1;
          assertLeaseHeld();
          log("CLAIM_LOST", { aid });
          await heartbeat();
          continue;
        }
        if (result.kind === "completed") counters.completed += 1;
        else if (result.kind === "not_found") counters.notFound += 1;
        else if (result.kind === "stale") counters.stale += 1;
        else counters.errors += 1;
        if (result.kind !== "completed") admitted -= 1;
        await heartbeat();
        if (config.maxCompleted !== null && counters.completed >= config.maxCompleted) {
          stopping = true;
          stopReason = "max_completed";
          return;
        }
        if (counters.attempted % config.progressEvery === 0) log("PROGRESS", counters);
      }
    } catch (error) {
      stopping = true;
      stopReason ??= "worker_error";
      throw error;
    }
  }

  const results = await Promise.allSettled(Array.from({ length: config.concurrency }, () => worker()));
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  return counters;
}

async function syncProfile(aid, expectedUpdatedAt, schemaVersion, startedAt) {
  let lastError;
  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt += 1) {
    const rateReady = await rateLimit(startedAt);
    if (!rateReady) {
      stopping = true;
      stopReason = "max_run_ms";
      return null;
    }
    const remainingMs = config.maxRunMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      stopping = true;
      stopReason = "max_run_ms";
      return null;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(config.requestTimeoutMs, remainingMs));
    try {
      const response = await fetch(config.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.secret}`,
          "content-type": "application/json",
          "x-profile-refresh-run-id": runId,
        },
        body: JSON.stringify({ aid, mode: "arena", expectedUpdatedAt, schemaVersion }),
        signal: controller.signal,
      });
      if (response.status === 404) {
        const detail = (await response.text().catch(() => "")).slice(0, 300);
        let payload;
        try {
          payload = JSON.parse(detail);
        } catch {}
        if (payload?.state === "not_found") {
          return { kind: "not_found", attempts: attempt, status: 404 };
        }
        const error = new Error(`sync endpoint returned an unexpected HTTP 404${detail ? `: ${detail}` : ""}`);
        error.fatal = true;
        throw error;
      }
      if (response.status === 409) return { kind: "stale", attempts: attempt, status: 409 };
      if (response.status === 401 || response.status === 403) {
        const error = new Error(`sync endpoint rejected credentials: HTTP ${response.status}`);
        error.fatal = true;
        throw error;
      }
      if (response.ok) {
        const body = await response.json();
        const storedUpdatedAt = normalizeUpdatedAt(body?.profileUpdatedAt);
        if (storedUpdatedAt === null || storedUpdatedAt < expectedUpdatedAt) {
          throw retryableError("sync endpoint stored an older Arena profile version", response.status);
        }
        if (Number(body?.schemaVersion) < schemaVersion) {
          throw retryableError("sync endpoint stored an older Arena schema version", response.status);
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
      if (runBudgetExpired(startedAt)) {
        stopping = true;
        stopReason = "max_run_ms";
        return null;
      }
      lastError = error;
      if (attempt > config.maxRetries || error?.retryable === false) break;
      const remainingMs = config.maxRunMs - (Date.now() - startedAt);
      const waitMs = backoff(attempt);
      if (waitMs >= remainingMs) {
        stopping = true;
        stopReason = "max_run_ms";
        return null;
      }
      await delay(waitMs);
    } finally {
      clearTimeout(timeout);
    }
  }
  const error = new Error(message(lastError));
  error.attempts = config.maxRetries + 1;
  error.status = lastError?.status ?? null;
  throw error;
}

async function loadUpdatedFeedWithRetry(url, tracked, excluded, startedAt) {
  const useValidators = getMeta("feed_source_url") === config.updatedUrl;
  const savedEtag = useValidators ? getMeta("feed_etag") : null;
  const savedModified = useValidators ? getMeta("feed_last_modified") : null;
  let lastError;
  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt += 1) {
    const remainingMs = config.maxRunMs - (Date.now() - startedAt);
    if (remainingMs <= 0) throw runBudgetError();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(config.requestTimeoutMs, remainingMs));
    try {
      const headers = {};
      if (savedEtag) headers["if-none-match"] = savedEtag;
      else if (savedModified) headers["if-modified-since"] = savedModified;
      const response = await fetchTarkovJson(url, { cache: "no-store", signal: controller.signal, headers });
      if (response.status === 304) {
        // Handle before response.ok (ok is false for 304) and before reading
        // the body. Without stored validators a 304 proves nothing.
        if (!savedEtag && !savedModified) {
          throw arenaFeedError("Arena updated feed unexpectedly returned 304", 304);
        }
        try {
          await response.body?.cancel();
        } catch {}
        return {
          counters: {
            arenaPlayers: tracked.size,
            sourceEntries: 0,
            invalidEntries: 0,
            trackedInFeed: 0,
            unknownInFeed: 0,
            eligible: 0,
            newProfiles: 0,
            updatedProfiles: 0,
            indexProfiles: 0,
            queuedVersions: 0,
            queuedNewProfiles: 0,
            queuedUpdatedProfiles: 0,
            maxFeedUpdatedAt: Number(getMeta("feed_watermark")) || 0,
            polledAt: Date.now(),
            feedNotModified: true,
            feedHttpStatus: 304,
          },
          pendingVersions: new Map(),
          feed: { notModified: true },
        };
      }
      if (!response.ok) {
        throw arenaFeedError(`Arena updated feed HTTP ${response.status}`, response.status);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Arena updated feed response has no readable body");
      const counters = {
        arenaPlayers: tracked.size,
        sourceEntries: 0,
        invalidEntries: 0,
        trackedInFeed: 0,
        unknownInFeed: 0,
        eligible: 0,
        newProfiles: 0,
        updatedProfiles: 0,
        indexProfiles: 0,
        queuedVersions: 0,
        queuedNewProfiles: 0,
        queuedUpdatedProfiles: 0,
        maxFeedUpdatedAt: 0,
        polledAt: 0,
        feedNotModified: false,
        feedHttpStatus: 200,
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
        if (excluded.has(aid)) return;
        const snapshot = tracked.get(aid);
        if (snapshot === undefined) counters.unknownInFeed += 1;
        else counters.trackedInFeed += 1;
        if (snapshot !== undefined && snapshot.updatedAt >= feedUpdatedAt &&
          snapshot.schemaVersion >= config.schemaVersion) return;
        counters.eligible += 1;
        const kind = snapshot === undefined ? "new" : "updated";
        if (kind === "new") counters.newProfiles += 1;
        else counters.updatedProfiles += 1;
        const pending = pendingVersions.get(aid);
        if (!pending || feedUpdatedAt > pending.feedUpdatedAt) {
          pendingVersions.set(aid, {
            feedUpdatedAt,
            schemaVersion: config.schemaVersion,
            kind,
            snapshotUpdatedAt: snapshot?.updatedAt ?? null,
          });
        }
      });
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        parser.append(decoder.decode(value, { stream: true }));
      }
      parser.finish(decoder.decode());
      counters.polledAt = Date.now();
      return {
        counters,
        pendingVersions,
        feed: {
          notModified: false,
          etag: response.headers.get("etag"),
          lastModified: response.headers.get("last-modified"),
        },
      };
    } catch (error) {
      if (runBudgetExpired(startedAt)) throw runBudgetError();
      lastError = error;
      if (attempt > config.maxRetries || error?.retryable === false) break;
      const remainingMs = config.maxRunMs - (Date.now() - startedAt);
      const waitMs = backoff(attempt);
      if (waitMs >= remainingMs) throw runBudgetError();
      await delay(waitMs);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

function arenaFeedError(text, status) {
  const error = new Error(text);
  error.status = status;
  // Unexpected 304 without validators is not retryable (same unconditional GET
  // would repeat it); fail fast like Seasonal.
  error.retryable = status === 408 || status === 429 || status >= 500;
  return error;
}

function feedUrlForRun() {
  const url = new URL(config.updatedUrl);
  url.searchParams.set("v", String(feedCacheSlot()));
  return url.href;
}

function getMeta(key) {
  return db.prepare("SELECT value FROM arena_profile_sync_meta WHERE key = ?").get(key)?.value ?? null;
}

function setMeta(key, value) {
  db.prepare("INSERT INTO arena_profile_sync_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, String(value));
}

function deleteMeta(key) {
  db.prepare("DELETE FROM arena_profile_sync_meta WHERE key = ?").run(key);
}

async function saveRunMeta(summary) {
  const values = {
    last_poll_at: summary.polledAt,
    last_feed_max_updated_at: summary.maxFeedUpdatedAt,
    last_feed_http_status: summary.feedHttpStatus ?? "",
    last_backlog: summary.backlog,
    last_new_profiles: summary.queuedNewProfiles,
    last_updated_profiles: summary.queuedUpdatedProfiles,
    last_errors: summary.errors,
    last_stale: summary.stale,
    last_duration_ms: summary.durationMs,
    last_summary: JSON.stringify({ at: Date.now(), ...summary }),
  };
  await writeTransaction(() => {
    for (const [key, value] of Object.entries(values)) setMeta(key, String(value));
  });
}

async function withDatabaseBusyRetry(work) {
  let lastError;
  for (let attempt = 1; attempt <= config.dbBusyRetries + 1; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      if (!isDatabaseBusy(error) || attempt > config.dbBusyRetries) break;
      const waitMs = backoff(attempt);
      log("DB_BUSY_RETRY", { attempt, waitMs, error: message(error) });
      await delay(waitMs);
    }
  }
  throw lastError;
}

async function writeTransaction(work) {
  return withDatabaseBusyRetry(() => {
    db.exec("BEGIN IMMEDIATE");
    try {
      if (leaseHeld) assertLeaseHeld();
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  });
}

function isDatabaseBusy(error) { return /database is (?:locked|busy)|SQLITE_BUSY/i.test(message(error)); }
function runBudgetExpired(startedAt) { return Date.now() - startedAt >= config.maxRunMs; }
function runBudgetError() {
  const error = new Error("Arena profile sync run budget exceeded");
  error.runBudgetExceeded = true;
  return error;
}
async function rateLimit(startedAt) {
  const startAt = Math.max(nextRequestAt, Date.now());
  nextRequestAt = startAt + Math.ceil(1000 / config.requestsPerSecond);
  const waitMs = startAt - Date.now();
  if (waitMs <= 0) return true;
  const remainingMs = config.maxRunMs - (Date.now() - startedAt);
  if (waitMs >= remainingMs) {
    await delay(Math.max(0, remainingMs));
    return false;
  }
  await delay(waitMs);
  return true;
}
function retryableError(text, status) { const error = new Error(text); error.status = status; error.retryable = true; return error; }
function backoff(attempt) { return Math.min(30_000, 1000 * 2 ** (attempt - 1)); }
function envInteger(name, fallback, minimum, maximum) {
  const value = process.env[name] == null || process.env[name] === "" ? fallback : Number(process.env[name]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return value;
}
function envOptionalPositiveInteger(name) {
  const value = process.env[name] == null || process.env[name] === "" ? null : Number(process.env[name]);
  if (value !== null && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(`${name} must be a positive integer`);
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
