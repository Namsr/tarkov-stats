#!/usr/bin/env node

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

const { argValue, hasArg, syncStringIndex } = await import(
  "./seasonal-profile-sync-core.mjs"
);

const DEFAULT_URL = "https://players.tarkov.dev/arena/index.json";
const DEFAULT_DB = "/data/players.db";

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

export async function syncArenaIndex(db, options = {}) {
  const url = options.url || process.env.ARENA_PLAYER_INDEX_URL || DEFAULT_URL;
  const beforeWrite = typeof options.beforeWrite === "function" ? options.beforeWrite : null;
  return syncStringIndex(db, {
    mode: "arena",
    label: "Arena",
    url,
    force: options.force === true,
    dryRun: options.dryRun === true,
    beforeWrite,
    signal: options.signal ?? AbortSignal.timeout(30_000),
  });
}

async function main() {
  if (hasArg(process.argv, "--help") || hasArg(process.argv, "-h")) return usage();
  const dbPath = argValue(process.argv, "--db", process.env.SQLITE_PATH || DEFAULT_DB);
  const resolved = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new DatabaseSync(resolved);
  db.exec("PRAGMA busy_timeout = 30000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  try {
    const result = await syncArenaIndex(db, {
      url: argValue(process.argv, "--url", process.env.ARENA_PLAYER_INDEX_URL || DEFAULT_URL),
      force: hasArg(process.argv, "--force"),
      dryRun: hasArg(process.argv, "--dry-run"),
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
