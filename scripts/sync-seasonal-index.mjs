#!/usr/bin/env node

import { DatabaseSync } from "node:sqlite";
import process from "node:process";
import {
  createStringObjectParser,
  isClearlyTruncatedIndex,
  normalizeAid,
  normalizeNickname,
  seasonalIndexCacheUrl,
} from "./seasonal-profile-sync-core.mjs";

const { fetchTarkovJson } = await import("../lib/tarkov-api.ts");
const { isSeasonalCollectorReady, loadSeasonalCycleConfig, seasonalUpstreamMode } = await import("../lib/seasonal/config.ts");
const { initializeSeasonalSchema } = await import("../lib/seasonal/storage.ts");

const cycle = loadSeasonalCycleConfig();
if (!cycle || !isSeasonalCollectorReady()) {
  throw new Error("Seasonal JSON feed is not configured or is not collector-ready");
}
const configuredSourceUrl = (process.env.SEASONAL_PROFILE_INDEX_URL || "").trim().replaceAll("{mode}", seasonalUpstreamMode());
const sourceUrl = argValue("--url", configuredSourceUrl);
if (!sourceUrl) throw new Error("SEASONAL_PROFILE_INDEX_URL is required");
const dbPath = argValue("--db", process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db");
const force = hasArg("--force");
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 30000");
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
initializeSeasonalSchema(db);
initSchema();

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}).finally(() => db.close());

async function main() {
  const startedAt = Date.now();
  const downloaded = await requestIndex();
  if (downloaded.unchanged) {
    saveMeta("last_poll_at", Date.now());
    saveMeta("last_status", "unchanged");
    saveMeta("duration_ms", Date.now() - startedAt);
    console.log("Seasonal player index is unchanged");
    return;
  }
  const syncedAt = Date.now();
  const result = await consumeIndex(downloaded.response, syncedAt, currentRowCount());
  const durationMs = Date.now() - startedAt;
  replaceIndex({ ...result, syncedAt, durationMs, ...downloaded });
  console.log(JSON.stringify({
    cycleId: cycle.cycleId,
    sourceRows: result.sourceRows,
    inserted: result.inserted,
    skipped: result.skipped,
    bytes: result.bytes,
    durationMs,
  }));
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS seasonal_player_index (
      cycle_id TEXT NOT NULL,
      aid INTEGER NOT NULL,
      nickname TEXT NOT NULL,
      nickname_lower TEXT NOT NULL,
      synced_at INTEGER NOT NULL,
      PRIMARY KEY (cycle_id, aid)
    );
    CREATE INDEX IF NOT EXISTS idx_seasonal_player_index_name
      ON seasonal_player_index(cycle_id, nickname_lower, aid);
    CREATE TABLE IF NOT EXISTS seasonal_player_index_next (
      cycle_id TEXT NOT NULL,
      aid INTEGER NOT NULL,
      nickname TEXT NOT NULL,
      nickname_lower TEXT NOT NULL,
      synced_at INTEGER NOT NULL,
      PRIMARY KEY (cycle_id, aid)
    );
    CREATE TABLE IF NOT EXISTS seasonal_player_index_meta (
      cycle_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (cycle_id, key)
    );
  `);
}

async function requestIndex() {
  const headers = {};
  if (!force) {
    const etag = getMeta("etag");
    const lastModified = getMeta("last_modified");
    if (etag) headers["if-none-match"] = etag;
    if (lastModified) headers["if-modified-since"] = lastModified;
  }
  const response = await fetchTarkovJson(seasonalIndexCacheUrl(sourceUrl), { headers, cache: "no-store" });
  if (response.status === 304) return { unchanged: true };
  if (!response.ok) throw new Error(`Seasonal index download failed: HTTP ${response.status}`);
  return {
    unchanged: false,
    response,
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
  };
}

async function consumeIndex(response, syncedAt, previousRows) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM seasonal_player_index_next WHERE cycle_id = ?").run(cycle.cycleId);
    const insert = db.prepare(`INSERT OR REPLACE INTO seasonal_player_index_next
      (cycle_id, aid, nickname, nickname_lower, synced_at) VALUES (?, ?, ?, ?, ?)`);
    let sourceRows = 0;
    let skipped = 0;
    const parser = createStringObjectParser((aidRaw, nicknameRaw) => {
      sourceRows += 1;
      const aid = normalizeAid(aidRaw);
      const nickname = normalizeNickname(nicknameRaw);
      if (aid === null || nickname === null) {
        skipped += 1;
        return;
      }
      insert.run(cycle.cycleId, aid, nickname, nickname.toLowerCase(), syncedAt);
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Seasonal index response has no readable body");
    const decoder = new TextDecoder();
    let bytes = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      parser.append(decoder.decode(value, { stream: true }));
    }
    parser.finish(decoder.decode());
    const rowCount = Number(db.prepare(
      "SELECT COUNT(*) AS n FROM seasonal_player_index_next WHERE cycle_id = ?",
    ).get(cycle.cycleId)?.n) || 0;
    if (rowCount === 0) throw new Error("Seasonal index contains no valid players");
    if (isClearlyTruncatedIndex(previousRows, rowCount)) {
      throw new Error(`Seasonal index appears truncated: ${rowCount} rows would replace ${previousRows}`);
    }
    db.exec("COMMIT");
    return { sourceRows, inserted: rowCount, skipped, bytes };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function replaceIndex(metadata) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM seasonal_player_index WHERE cycle_id = ?").run(cycle.cycleId);
    db.prepare(`INSERT INTO seasonal_player_index (cycle_id, aid, nickname, nickname_lower, synced_at)
      SELECT cycle_id, aid, nickname, nickname_lower, synced_at
      FROM seasonal_player_index_next WHERE cycle_id = ?`).run(cycle.cycleId);
    db.prepare(`INSERT INTO seasonal_player_index_meta (cycle_id, key, value) VALUES (?, ?, ?)
      ON CONFLICT(cycle_id, key) DO UPDATE SET value = excluded.value`).run(cycle.cycleId, "synced_at", metadata.syncedAt);
    for (const [key, value] of Object.entries({
      source_url: sourceUrl,
      row_count: metadata.inserted,
      source_rows: metadata.sourceRows,
      skipped: metadata.skipped,
      bytes: metadata.bytes,
      duration_ms: metadata.durationMs,
      last_poll_at: Date.now(),
      last_status: "updated",
    })) setMeta(key, value);
    if (metadata.etag) setMeta("etag", metadata.etag);
    else deleteMeta("etag");
    if (metadata.lastModified) setMeta("last_modified", metadata.lastModified);
    else deleteMeta("last_modified");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  db.prepare("DELETE FROM seasonal_player_index_next WHERE cycle_id = ?").run(cycle.cycleId);
}

function getMeta(key) {
  return db.prepare("SELECT value FROM seasonal_player_index_meta WHERE cycle_id = ? AND key = ?")
    .get(cycle.cycleId, key)?.value ?? null;
}

function setMeta(key, value) {
  db.prepare(`INSERT INTO seasonal_player_index_meta (cycle_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(cycle_id, key) DO UPDATE SET value = excluded.value`).run(cycle.cycleId, key, String(value));
}

function deleteMeta(key) {
  db.prepare("DELETE FROM seasonal_player_index_meta WHERE cycle_id = ? AND key = ?")
    .run(cycle.cycleId, key);
}

function currentRowCount() {
  return Number(db.prepare(
    "SELECT COUNT(*) AS n FROM seasonal_player_index WHERE cycle_id = ?",
  ).get(cycle.cycleId)?.n) || 0;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback) {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
    return process.argv[index + 1];
  }
  return fallback;
}

function saveMeta(key, value) { setMeta(key, value); }
