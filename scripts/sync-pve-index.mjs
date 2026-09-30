#!/usr/bin/env node

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const { argValue, hasArg, syncStringIndex } = await import(
  "./seasonal-profile-sync-core.mjs"
);

const DEFAULT_URL = "https://players.tarkov.dev/pve/index.json";
const DEFAULT_DB = "/data/players.db";
// A stalled upstream must not hold the shared data-sync lock: the deploy path
// probes the same flock. The arena index sibling uses the same bound. The clock
// starts in main() ahead of the SQLite setup, so it bounds the whole run rather
// than the network alone.
const DOWNLOAD_TIMEOUT_MS = 30_000;

function usage() {
  console.log(`Usage:
  node --experimental-strip-types --experimental-sqlite scripts/sync-pve-index.mjs [options]

Options:
  --db <path>       SQLite DB path. Default: SQLITE_PATH or ${DEFAULT_DB}
  --url <url>       Source index URL. Default: ${DEFAULT_URL}
  --force           Ignore saved ETag/Last-Modified and download anyway
  --dry-run         Download and validate, but do not write SQLite
`);
}

async function main() {
  if (hasArg(process.argv, "--help") || hasArg(process.argv, "-h")) {
    usage();
    return;
  }

  const dbPath = argValue(process.argv, "--db", process.env.SQLITE_PATH || DEFAULT_DB);
  const url = argValue(process.argv, "--url", process.env.PVE_PLAYER_INDEX_URL || DEFAULT_URL);
  const force = hasArg(process.argv, "--force");
  const dryRun = hasArg(process.argv, "--dry-run");
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const resolved = path.resolve(dbPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new DatabaseSync(resolved);
  db.exec("PRAGMA busy_timeout = 30000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");

  try {
    const outcome = await syncStringIndex(db, {
      mode: "pve",
      label: "PvE",
      url,
      force,
      dryRun,
      signal,
    });
    if (outcome.unchanged) {
      console.log("PvE player index is unchanged");
      return;
    }
    const { sourceRows, inserted, skipped, bytes } = outcome;
    if (dryRun) {
      console.log(JSON.stringify({ sourceRows, inserted, skipped, bytes, dryRun: true, url }));
      return;
    }
    console.log(JSON.stringify({ sourceRows, inserted, skipped, bytes, url }));
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
