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

async function requestIndex(url, db, force) {
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

  return {
    unchanged: false,
    res,
    etag: res.headers.get("etag"),
    lastModified: res.headers.get("last-modified"),
  };
}

function skipWs(buffer, pos) {
  while (pos < buffer.length && /\s/.test(buffer[pos])) pos += 1;
  return pos;
}

function readJsonString(buffer, start) {
  if (start >= buffer.length) return null;
  if (buffer[start] !== "\"") throw new Error("expected JSON string");

  let out = "";
  let i = start + 1;
  while (i < buffer.length) {
    const ch = buffer[i];
    if (ch === "\"") return { value: out, next: i + 1 };
    if (ch !== "\\") {
      out += ch;
      i += 1;
      continue;
    }

    if (i + 1 >= buffer.length) return null;
    const esc = buffer[i + 1];
    if (esc === "u") {
      if (i + 6 > buffer.length) return null;
      const hex = buffer.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error("invalid unicode escape");
      out += String.fromCharCode(Number.parseInt(hex, 16));
      i += 6;
      continue;
    }

    const decoded =
      esc === "\"" ? "\"" :
      esc === "\\" ? "\\" :
      esc === "/" ? "/" :
      esc === "b" ? "\b" :
      esc === "f" ? "\f" :
      esc === "n" ? "\n" :
      esc === "r" ? "\r" :
      esc === "t" ? "\t" :
      null;
    if (decoded == null) throw new Error("invalid escape sequence");
    out += decoded;
    i += 2;
  }

  return null;
}

function createIndexParser(onEntry) {
  let buffer = "";
  let pos = 0;
  let state = "start";
  let currentKey = "";
  let done = false;

  function parse(final = false) {
    while (!done) {
      pos = skipWs(buffer, pos);
      if (pos >= buffer.length) break;

      if (state === "start") {
        if (buffer[pos] === "<") throw new Error("index download returned HTML instead of JSON");
        if (buffer[pos] !== "{") throw new Error("index JSON must be an object");
        pos += 1;
        state = "keyOrEnd";
        continue;
      }

      if (state === "keyOrEnd") {
        if (buffer[pos] === "}") {
          pos += 1;
          state = "done";
          done = true;
          break;
        }
        const key = readJsonString(buffer, pos);
        if (!key) break;
        currentKey = key.value;
        pos = key.next;
        state = "colon";
        continue;
      }

      if (state === "colon") {
        if (buffer[pos] !== ":") throw new Error("expected ':' after account id");
        pos += 1;
        state = "value";
        continue;
      }

      if (state === "value") {
        const value = readJsonString(buffer, pos);
        if (!value) break;
        onEntry(currentKey, value.value);
        currentKey = "";
        pos = value.next;
        state = "commaOrEnd";
        continue;
      }

      if (state === "commaOrEnd") {
        if (buffer[pos] === ",") {
          pos += 1;
          state = "keyOrEnd";
          continue;
        }
        if (buffer[pos] === "}") {
          pos += 1;
          state = "done";
          done = true;
          break;
        }
        throw new Error("expected ',' or '}' after nickname");
      }
    }

    if (pos > 0) {
      buffer = buffer.slice(pos);
      pos = 0;
    }

    if (final) {
      pos = skipWs(buffer, pos);
      if (!done || pos < buffer.length) throw new Error("truncated or invalid index JSON");
    }
  }

  return {
    append(chunk) {
      buffer += chunk;
      parse(false);
    },
    finish(chunk) {
      if (chunk) buffer += chunk;
      parse(true);
    },
  };
}

async function streamIndex(response, onEntry) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("index response has no readable body");

  const decoder = new TextDecoder();
  const parser = createIndexParser(onEntry);
  let bytes = 0;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    parser.append(decoder.decode(value, { stream: true }));
  }
  parser.finish(decoder.decode());
  return bytes;
}

async function consumeIndex(db, response, syncedAt, dryRun) {
  let insert = null;
  if (!dryRun) {
    initImportTable(db);
    insert = db.prepare(
      "INSERT OR REPLACE INTO player_index_next " +
        "(aid, nickname, nickname_lower, synced_at) VALUES (?, ?, ?, ?)"
    );
  }

  let inserted = 0;
  let skipped = 0;
  let sourceRows = 0;

  if (!dryRun) db.exec("BEGIN");
  try {
    const bytes = await streamIndex(response, (aidRaw, nicknameRaw) => {
      sourceRows += 1;
      const aid = Number(aidRaw);
      const nickname = typeof nicknameRaw === "string" ? nicknameRaw.trim() : "";
      if (!Number.isInteger(aid) || aid <= 0 || !NICKNAME_RE.test(nickname)) {
        skipped += 1;
        return;
      }

      if (insert) insert.run(aid, nickname, nickname.toLowerCase(), syncedAt);
      inserted += 1;

      if (inserted % 100000 === 0) {
        console.log(`loaded ${inserted.toLocaleString("en-US")} rows...`);
      }
    });
    if (!dryRun) db.exec("COMMIT");
    return { inserted, skipped, sourceRows, bytes };
  } catch (error) {
    if (!dryRun) db.exec("ROLLBACK");
    throw error;
  }
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

  const downloaded = await requestIndex(url, db, force);
  if (downloaded.unchanged) {
    console.log("player index is unchanged");
    db.close();
    return;
  }

  const syncedAt = Date.now();
  const result = await consumeIndex(db, downloaded.res, syncedAt, dryRun);
  console.log(
    `downloaded ${(result.bytes / 1024 / 1024).toFixed(1)} MiB, ` +
      `${result.sourceRows.toLocaleString("en-US")} source rows`
  );

  if (dryRun) {
    console.log(`dry run: ${result.inserted.toLocaleString("en-US")} valid rows`);
    db.close();
    return;
  }

  swapImportTable(db, {
    syncedAt,
    url,
    inserted: result.inserted,
    etag: downloaded.etag,
    lastModified: downloaded.lastModified,
  });

  db.exec("DROP TABLE IF EXISTS player_index_next");
  db.close();

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `done: ${result.inserted.toLocaleString("en-US")} rows, ` +
      `${result.skipped.toLocaleString("en-US")} skipped, ${seconds}s`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
