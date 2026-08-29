#!/usr/bin/env node

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

const { fetchTarkovJson } = await import("../lib/tarkov-api.ts");
const { createStringObjectParser, normalizeAid, normalizeNickname, isClearlyTruncatedIndex } = await import(
  "./seasonal-profile-sync-core.mjs"
);

const DEFAULT_URL = "https://players.tarkov.dev/arena/index.json";
const DEFAULT_DB = "/data/players.db";

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

function usage() {
  console.log(`Usage:
  node --experimental-strip-types --experimental-sqlite scripts/sync-arena-index.mjs [options]

Options:
  --db <path>       SQLite DB path. Default: SQLITE_PATH or ${DEFAULT_DB}
  --url <url>       Source index URL. Default: ${DEFAULT_URL}
  --force           Ignore saved ETag/Last-Modified and download anyway
  --dry-run         Download and validate, but do not write SQLite
`);
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS arena_player_index (
      mode TEXT NOT NULL CHECK (mode = 'arena'),
      aid INTEGER NOT NULL,
      nickname TEXT NOT NULL,
      nickname_lower TEXT NOT NULL,
      synced_at INTEGER NOT NULL,
      PRIMARY KEY (mode, aid)
    );
    CREATE INDEX IF NOT EXISTS idx_arena_player_index_nickname_lower
      ON arena_player_index(mode, nickname_lower, aid);
    CREATE TABLE IF NOT EXISTS arena_player_index_next (
      mode TEXT NOT NULL CHECK (mode = 'arena'),
      aid INTEGER NOT NULL,
      nickname TEXT NOT NULL,
      nickname_lower TEXT NOT NULL,
      synced_at INTEGER NOT NULL,
      PRIMARY KEY (mode, aid)
    );
    CREATE TABLE IF NOT EXISTS arena_player_index_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function getMeta(db, key) {
  return db.prepare("SELECT value FROM arena_player_index_meta WHERE key = ?").get(key)?.value ?? null;
}

function setMeta(db, key, value) {
  db.prepare(`INSERT INTO arena_player_index_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

function deleteMeta(db, key) {
  db.prepare("DELETE FROM arena_player_index_meta WHERE key = ?").run(key);
}

function currentRowCount(db) {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM arena_player_index WHERE mode = 'arena'").get()?.n) || 0;
}

async function requestIndex(db, url, force) {
  const headers = {};
  if (!force) {
    const etag = getMeta(db, "etag");
    const lastModified = getMeta(db, "last_modified");
    if (etag) headers["if-none-match"] = etag;
    if (lastModified) headers["if-modified-since"] = lastModified;
  }
  const response = await fetchTarkovJson(url, { headers, cache: "no-store" });
  if (response.status === 304) return { unchanged: true };
  if (!response.ok) throw new Error(`Arena index download failed: HTTP ${response.status}`);
  return {
    unchanged: false,
    response,
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
  };
}

async function consumeIndex(db, response, syncedAt, dryRun, previousRows) {
  let insert = null;
  if (!dryRun) {
    db.exec("BEGIN IMMEDIATE");
    db.prepare("DELETE FROM arena_player_index_next WHERE mode = 'arena'").run();
    insert = db.prepare(`INSERT OR REPLACE INTO arena_player_index_next
      (mode, aid, nickname, nickname_lower, synced_at) VALUES ('arena', ?, ?, ?, ?)`);
  }

  let sourceRows = 0;
  let inserted = 0;
  let skipped = 0;
  let bytes = 0;
  try {
    const parser = createStringObjectParser((aidRaw, nicknameRaw) => {
      sourceRows += 1;
      const aid = normalizeAid(aidRaw);
      const nickname = normalizeNickname(nicknameRaw);
      if (aid === null || nickname === null) {
        skipped += 1;
        return;
      }
      if (insert) insert.run(aid, nickname, nickname.toLowerCase(), syncedAt);
      inserted += 1;
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Arena index response has no readable body");
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      parser.append(decoder.decode(value, { stream: true }));
    }
    parser.finish(decoder.decode());
    const rowCount = dryRun
      ? inserted
      : Number(db.prepare("SELECT COUNT(*) AS n FROM arena_player_index_next WHERE mode = 'arena'").get()?.n) || 0;
    if (rowCount === 0) throw new Error("Arena index contains no valid players");
    if (isClearlyTruncatedIndex(previousRows, rowCount)) {
      throw new Error(`Arena index appears truncated: ${rowCount} rows would replace ${previousRows}`);
    }
    if (!dryRun) db.exec("COMMIT");
    return { sourceRows, inserted: rowCount, skipped, bytes };
  } catch (error) {
    if (!dryRun) db.exec("ROLLBACK");
    throw error;
  }
}

function replaceIndex(db, metadata) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      DROP TABLE arena_player_index;
      ALTER TABLE arena_player_index_next RENAME TO arena_player_index;
      CREATE INDEX idx_arena_player_index_nickname_lower
        ON arena_player_index(mode, nickname_lower, aid);
    `);
    for (const [key, value] of Object.entries({
      synced_at: metadata.syncedAt,
      source_url: metadata.url,
      row_count: metadata.inserted,
      source_rows: metadata.sourceRows,
      skipped: metadata.skipped,
      bytes: metadata.bytes,
      duration_ms: metadata.durationMs,
      last_poll_at: Date.now(),
      last_status: "updated",
    })) setMeta(db, key, value);
    if (metadata.etag) setMeta(db, "etag", metadata.etag);
    else deleteMeta(db, "etag");
    if (metadata.lastModified) setMeta(db, "last_modified", metadata.lastModified);
    else deleteMeta(db, "last_modified");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function syncArenaIndex(db, options = {}) {
  const url = options.url || process.env.ARENA_PLAYER_INDEX_URL || DEFAULT_URL;
  const force = options.force === true;
  const dryRun = options.dryRun === true;
  const startedAt = Date.now();
  initSchema(db);
  const downloaded = await requestIndex(db, url, force);
  if (downloaded.unchanged) {
    if (!dryRun) {
      setMeta(db, "last_poll_at", Date.now());
      setMeta(db, "last_status", "unchanged");
      setMeta(db, "duration_ms", Date.now() - startedAt);
    }
    return { unchanged: true, dryRun, url, durationMs: Date.now() - startedAt };
  }
  const syncedAt = Date.now();
  const result = await consumeIndex(db, downloaded.response, syncedAt, dryRun, currentRowCount(db));
  if (!dryRun) replaceIndex(db, { ...result, syncedAt, durationMs: Date.now() - startedAt, url, ...downloaded });
  return { ...result, unchanged: false, dryRun, url, durationMs: Date.now() - startedAt };
}

async function main() {
  if (hasArg("--help") || hasArg("-h")) return usage();
  const dbPath = argValue("--db", process.env.SQLITE_PATH || DEFAULT_DB);
  const resolved = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new DatabaseSync(resolved);
  db.exec("PRAGMA busy_timeout = 30000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  try {
    const result = await syncArenaIndex(db, {
      url: argValue("--url", process.env.ARENA_PLAYER_INDEX_URL || DEFAULT_URL),
      force: hasArg("--force"),
      dryRun: hasArg("--dry-run"),
    });
    if (result.unchanged) console.log("Arena player index is unchanged");
    else console.log(JSON.stringify(result));
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
