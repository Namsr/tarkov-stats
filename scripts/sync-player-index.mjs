#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const DEFAULT_URL = "https://players.tarkov.dev/profile/index.json";
const DEFAULT_UA =
  "Mozilla/5.0 (compatible; TarkovStatsComparator/0.1; +https://tarkovstats.ru)";
const NICKNAME_RE = /^[a-zA-Z0-9_-]{1,15}$/;

function hasArg(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback) {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) {
    return process.argv[i + 1];
  }
  return fallback;
}

function usage() {
  console.log(`Usage:
  node --experimental-sqlite scripts/sync-player-index.mjs [options]

Options:
  --db <path>       SQLite DB path. Default: SQLITE_PATH or /data/players.db
  --url <url>       Source index URL. Default: ${DEFAULT_URL}
  --force           Ignore saved ETag/Last-Modified and download anyway
  --dry-run         Download and validate, but do not write SQLite
`);
}

function openDb(file) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return { resolved, dbPromise: import("node:sqlite") };
}

function getMeta(db, key) {
  const row = db
    .prepare("SELECT value FROM player_index_meta WHERE key = ?")
    .get(key);
  return typeof row?.value === "string" ? row.value : null;
}

function setMeta(db, key, value) {
  db.prepare(
    "INSERT INTO player_index_meta (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

function initMeta(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS player_index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);
}

function initImportTable(db) {
  db.exec(`
DROP TABLE IF EXISTS player_index_next;
CREATE TABLE player_index_next (
  aid INTEGER PRIMARY KEY,
  nickname TEXT NOT NULL,
  nickname_lower TEXT NOT NULL,
  synced_at INTEGER NOT NULL
);
`);
}

async function fetchIndex(url, db, force) {
  const headers = {
    accept: "application/json",
    "user-agent": process.env.PLAYER_INDEX_USER_AGENT || DEFAULT_UA,
  };

  if (!force) {
    const etag = getMeta(db, "etag");
    const lastModified = getMeta(db, "last_modified");
    if (etag) headers["if-none-match"] = etag;
    if (lastModified) headers["if-modified-since"] = lastModified;
  }

  const res = await fetch(url, { headers });
  if (res.status === 304) return { unchanged: true };
  if (!res.ok) {
    throw new Error(`index download failed: HTTP ${res.status}`);
  }

  const text = await res.text();
  if (text.trimStart().startsWith("<")) {
    throw new Error("index download returned HTML instead of JSON");
  }

  const json = JSON.parse(text);
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("index JSON must be an object of accountId -> nickname");
  }

  return {
    unchanged: false,
    json,
    etag: res.headers.get("etag"),
    lastModified: res.headers.get("last-modified"),
    bytes: Buffer.byteLength(text),
  };
}

function loadImportTable(db, json, syncedAt) {
  initImportTable(db);

  const insert = db.prepare(
    "INSERT OR REPLACE INTO player_index_next " +
      "(aid, nickname, nickname_lower, synced_at) VALUES (?, ?, ?, ?)"
  );

  let inserted = 0;
  let skipped = 0;

  db.exec("BEGIN");
  try {
    for (const [aidRaw, nicknameRaw] of Object.entries(json)) {
      const aid = Number(aidRaw);
      const nickname = typeof nicknameRaw === "string" ? nicknameRaw.trim() : "";
      if (!Number.isInteger(aid) || aid <= 0 || !NICKNAME_RE.test(nickname)) {
        skipped += 1;
        continue;
      }

      insert.run(aid, nickname, nickname.toLowerCase(), syncedAt);
      inserted += 1;

      if (inserted % 100000 === 0) {
        console.log(`loaded ${inserted.toLocaleString("en-US")} rows...`);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return { inserted, skipped };
}

function swapImportTable(db, meta) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
DROP TABLE IF EXISTS player_index;
ALTER TABLE player_index_next RENAME TO player_index;
CREATE INDEX IF NOT EXISTS idx_player_index_nickname_lower
  ON player_index(nickname_lower);
`);
    setMeta(db, "synced_at", String(meta.syncedAt));
    setMeta(db, "source_url", meta.url);
    setMeta(db, "row_count", String(meta.inserted));
    if (meta.etag) setMeta(db, "etag", meta.etag);
    if (meta.lastModified) setMeta(db, "last_modified", meta.lastModified);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function main() {
  if (hasArg("--help") || hasArg("-h")) {
    usage();
    return;
  }

  const file = argValue("--db", process.env.SQLITE_PATH || "/data/players.db");
  const url = argValue("--url", DEFAULT_URL);
  const force = hasArg("--force");
  const dryRun = hasArg("--dry-run");
  const started = Date.now();

  const { resolved, dbPromise } = openDb(file);
  const { DatabaseSync } = await dbPromise;
  const db = new DatabaseSync(resolved);
  db.exec("PRAGMA busy_timeout = 30000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  initMeta(db);

  console.log(`syncing player index from ${url}`);
  console.log(`sqlite: ${resolved}`);

  const downloaded = await fetchIndex(url, db, force);
  if (downloaded.unchanged) {
    console.log("player index is unchanged");
    db.close();
    return;
  }

  const sourceRows = Object.keys(downloaded.json).length;
  console.log(
    `downloaded ${(downloaded.bytes / 1024 / 1024).toFixed(1)} MiB, ` +
      `${sourceRows.toLocaleString("en-US")} source rows`
  );

  if (dryRun) {
    let valid = 0;
    for (const [aidRaw, nicknameRaw] of Object.entries(downloaded.json)) {
      const aid = Number(aidRaw);
      const nickname = typeof nicknameRaw === "string" ? nicknameRaw.trim() : "";
      if (Number.isInteger(aid) && aid > 0 && NICKNAME_RE.test(nickname)) valid += 1;
    }
    console.log(`dry run: ${valid.toLocaleString("en-US")} valid rows`);
    db.close();
    return;
  }

  const syncedAt = Date.now();
  const { inserted, skipped } = loadImportTable(db, downloaded.json, syncedAt);
  swapImportTable(db, {
    syncedAt,
    url,
    inserted,
    etag: downloaded.etag,
    lastModified: downloaded.lastModified,
  });

  db.exec("DROP TABLE IF EXISTS player_index_next");
  db.close();

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `done: ${inserted.toLocaleString("en-US")} rows, ` +
      `${skipped.toLocaleString("en-US")} skipped, ${seconds}s`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
