import {
  argValue,
  createTimestampObjectParser,
  feedCacheSlot,
  hasArg,
  normalizeUpdatedAt,
} from "./regular-profile-sync-core.mjs";

export { argValue, createTimestampObjectParser, feedCacheSlot, hasArg, normalizeUpdatedAt };

/**
 * Small streaming parser for Tarkov's `{ "aid": "nickname" }` index files.
 * It intentionally accepts only strings as values: an HTML error page or a
 * malformed number must never be imported as a player index.
 */
export function createStringObjectParser(onEntry) {
  let buffer = "";
  let position = 0;
  let state = "start";
  let key = "";
  let done = false;

  function readString() {
    if (buffer[position] !== '"') throw new Error("expected JSON string");
    for (let end = position + 1; end < buffer.length; end += 1) {
      if (buffer[end] === "\\") {
        end += 1;
        if (end >= buffer.length) return null;
      } else if (buffer[end] === '"') {
        const raw = buffer.slice(position, end + 1);
        position = end + 1;
        return JSON.parse(raw);
      }
    }
    return null;
  }

  function parse(final) {
    for (;;) {
      while (/\s/.test(buffer[position] ?? "")) position += 1;
      if (position >= buffer.length) break;
      if (done) throw new Error("unexpected data after JSON object");
      if (state === "start") {
        if (buffer[position] === "<") throw new Error("index response returned HTML");
        if (buffer[position] !== "{") throw new Error("index JSON must be an object");
        position += 1;
        state = "key";
        continue;
      }
      if (state === "key") {
        if (buffer[position] === "}") {
          position += 1;
          done = true;
          state = "done";
          continue;
        }
        const value = readString();
        if (value === null) break;
        key = value;
        state = "colon";
        continue;
      }
      if (state === "colon") {
        if (buffer[position] !== ":") throw new Error("expected ':' after account id");
        position += 1;
        state = "value";
        continue;
      }
      if (state === "value") {
        const value = readString();
        if (value === null) break;
        onEntry(key, value);
        state = "comma";
        continue;
      }
      if (state === "comma") {
        if (buffer[position] === ",") {
          position += 1;
          state = "key";
        } else if (buffer[position] === "}") {
          position += 1;
          done = true;
          state = "done";
        } else {
          throw new Error("expected ',' or '}' after nickname");
        }
        continue;
      }
    }

    if (position > 0) {
      buffer = buffer.slice(position);
      position = 0;
    }
    if (final) {
      while (/\s/.test(buffer[position] ?? "")) position += 1;
      if (!done || position !== buffer.length) throw new Error("truncated or invalid index JSON");
    }
  }

  return {
    append(chunk) {
      buffer += chunk;
      parse(false);
    },
    finish(chunk = "") {
      buffer += chunk;
      parse(true);
    },
  };
}
export function seasonalFeedCacheUrl(value, now = Date.now()) {
  const url = new URL(value);
  url.searchParams.set("v", String(feedCacheSlot(now)));
  return url.toString();
}

export function seasonalIndexCacheUrl(value, now = Date.now()) {
  const url = new URL(value);
  url.searchParams.set("v", String(feedCacheSlot(now)));
  return url.toString();
}

export function classifySeasonalVersion(expected, actual) {
  const target = normalizeUpdatedAt(expected);
  const received = normalizeUpdatedAt(actual);
  if (target === null || received === null) return "invalid";
  if (received < target) return "stale";
  if (received > target) return "superseded";
  return "current";
}

export function normalizeAid(value) {
  const aid = Number(value);
  return Number.isSafeInteger(aid) && aid > 0 ? aid : null;
}

export function normalizeNickname(value) {
  const nickname = typeof value === "string" ? value.trim() : "";
  return /^[a-zA-Z0-9_-]{1,15}$/.test(nickname) ? nickname : null;
}

export function isClearlyTruncatedIndex(previousRows, nextRows) {
  return previousRows > 0 && nextRows * 2 < previousRows;
}

function initStringIndexSchema(db, mode) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${mode}_player_index (
      mode TEXT NOT NULL CHECK (mode = '${mode}'),
      aid INTEGER NOT NULL,
      nickname TEXT NOT NULL,
      nickname_lower TEXT NOT NULL,
      synced_at INTEGER NOT NULL,
      PRIMARY KEY (mode, aid)
    );
    CREATE INDEX IF NOT EXISTS idx_${mode}_player_index_nickname_lower
      ON ${mode}_player_index(mode, nickname_lower, aid);
    CREATE TABLE IF NOT EXISTS ${mode}_player_index_next (
      mode TEXT NOT NULL CHECK (mode = '${mode}'),
      aid INTEGER NOT NULL,
      nickname TEXT NOT NULL,
      nickname_lower TEXT NOT NULL,
      synced_at INTEGER NOT NULL,
      PRIMARY KEY (mode, aid)
    );
    CREATE TABLE IF NOT EXISTS ${mode}_player_index_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function getStringIndexMeta(db, mode, key) {
  const row = db.prepare(`SELECT value FROM ${mode}_player_index_meta WHERE key = ?`).get(key);
  return typeof row?.value === "string" ? row.value : null;
}

function setStringIndexMeta(db, mode, key, value) {
  db.prepare(`
    INSERT INTO ${mode}_player_index_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

function deleteStringIndexMeta(db, mode, key) {
  db.prepare(`DELETE FROM ${mode}_player_index_meta WHERE key = ?`).run(key);
}

function currentStringIndexRowCount(db, mode) {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${mode}_player_index WHERE mode = '${mode}'`).get()?.n) || 0;
}

async function consumeStringIndex(db, { mode, label, response, syncedAt, dryRun, previousRows, beforeWrite, signal }) {
  beforeWrite?.();
  let insert = null;
  let sourceRows = 0;
  let inserted = 0;
  let skipped = 0;
  let bytes = 0;
  if (!dryRun) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`DELETE FROM ${mode}_player_index_next WHERE mode = '${mode}'`).run();
      insert = db.prepare(`
        INSERT OR REPLACE INTO ${mode}_player_index_next
          (mode, aid, nickname, nickname_lower, synced_at)
        VALUES ('${mode}', ?, ?, ?, ?)
      `);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
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
      if (beforeWrite && inserted % 1000 === 0) beforeWrite();
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error(`${label} index response has no readable body`);

    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (signal?.aborted) throw signal.reason ?? new Error(`${label} index sync aborted`);
      bytes += value.byteLength;
      parser.append(decoder.decode(value, { stream: true }));
    }
    parser.finish(decoder.decode());
    const rowCount = dryRun
      ? inserted
      : Number(db.prepare(`SELECT COUNT(*) AS n FROM ${mode}_player_index_next WHERE mode = '${mode}'`).get()?.n) || 0;
    if (rowCount === 0) throw new Error(`${label} index contains no valid players`);
    if (isClearlyTruncatedIndex(previousRows, rowCount)) {
      throw new Error(`${label} index appears truncated: ${rowCount} rows would replace ${previousRows}`);
    }
    if (!dryRun) {
      beforeWrite?.();
      db.exec("COMMIT");
    }
    return { sourceRows, inserted: rowCount, skipped, bytes };
  } catch (error) {
    if (!dryRun) db.exec("ROLLBACK");
    throw error;
  }
}

function replaceStringIndex(db, mode, metadata, beforeWrite) {
  beforeWrite?.();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      DROP TABLE ${mode}_player_index;
      ALTER TABLE ${mode}_player_index_next RENAME TO ${mode}_player_index;
      CREATE INDEX idx_${mode}_player_index_nickname_lower
        ON ${mode}_player_index(mode, nickname_lower, aid);
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
    })) setStringIndexMeta(db, mode, key, value);
    if (metadata.etag) setStringIndexMeta(db, mode, "etag", metadata.etag);
    else deleteStringIndexMeta(db, mode, "etag");
    if (metadata.lastModified) setStringIndexMeta(db, mode, "last_modified", metadata.lastModified);
    else deleteStringIndexMeta(db, mode, "last_modified");
    beforeWrite?.();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Shared download-validate-swap for the arena/pve string player indexes.
 * `mode` selects the table family (`arena` or `pve`), `label` only names
 * error strings. Table/column names interpolate the internal mode literal,
 * never user input.
 */
export async function syncStringIndex(db, options) {
  const { mode, label, url, force = false, dryRun = false, beforeWrite = null } = options;
  const hook = typeof beforeWrite === "function" ? beforeWrite : null;
  const signal = options.signal ?? AbortSignal.timeout(30_000);
  const startedAt = Date.now();
  const { fetchTarkovJson } = await import("../lib/tarkov-api.ts");
  initStringIndexSchema(db, mode);

  const headers = {};
  if (!force) {
    const etag = getStringIndexMeta(db, mode, "etag");
    const lastModified = getStringIndexMeta(db, mode, "last_modified");
    if (etag) headers["if-none-match"] = etag;
    if (lastModified) headers["if-modified-since"] = lastModified;
  }
  const response = await fetchTarkovJson(url, { headers, cache: "no-store", signal });
  if (response.status === 304) {
    if (!dryRun) {
      db.exec("BEGIN IMMEDIATE");
      try {
        hook?.();
        setStringIndexMeta(db, mode, "last_poll_at", Date.now());
        setStringIndexMeta(db, mode, "last_status", "unchanged");
        setStringIndexMeta(db, mode, "duration_ms", Date.now() - startedAt);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    return { unchanged: true, dryRun, url, durationMs: Date.now() - startedAt };
  }
  if (!response.ok) throw new Error(`${label} index download failed: HTTP ${response.status}`);
  const syncedAt = Date.now();
  const result = await consumeStringIndex(db, {
    mode, label, response, syncedAt, dryRun,
    previousRows: currentStringIndexRowCount(db, mode),
    beforeWrite: hook, signal,
  });
  if (!dryRun) {
    replaceStringIndex(db, mode, {
      ...result, syncedAt, durationMs: Date.now() - startedAt, url,
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
    }, hook);
  }
  return { ...result, unchanged: false, dryRun, url, durationMs: Date.now() - startedAt };
}

export function enqueueMissingSeasonalIndexProfiles(db, cycleId, fallbackUpdatedAt, queuedAt = Date.now()) {
  const indexEntries = Number(db.prepare(
    "SELECT COUNT(*) AS n FROM seasonal_player_index WHERE cycle_id = ?",
  ).get(cycleId)?.n) || 0;
  const result = db.prepare(`
    INSERT OR IGNORE INTO seasonal_profile_sync_queue
      (cycle_id, aid, feed_updated_at, status, attempts, updated_at)
    SELECT player_index.cycle_id, player_index.aid, ?, 'pending', 0, ?
    FROM seasonal_player_index AS player_index
    LEFT JOIN excluded_players AS excluded ON excluded.aid = player_index.aid
    WHERE player_index.cycle_id = ?
      AND excluded.aid IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM progression_snapshots AS snapshot
        WHERE snapshot.mode = 'seasonal'
          AND snapshot.cycle_id = player_index.cycle_id
          AND snapshot.aid = player_index.aid
      )
  `).run(fallbackUpdatedAt, queuedAt, cycleId);
  return { indexEntries, indexedMissingQueued: Number(result.changes) };
}

export function summarizeSeasonalCoverage(db, cycleId) {
  const row = db.prepare(`
    WITH latest AS (
      SELECT aid, MAX(profile_updated_at) AS updated_at
      FROM progression_snapshots
      WHERE mode = 'seasonal' AND cycle_id = ?
      GROUP BY aid
    )
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN latest.updated_at IS NULL THEN 1 ELSE 0 END) AS missing,
      SUM(CASE WHEN latest.updated_at IS NOT NULL
          AND latest.updated_at < player_profiles.profile_updated_at THEN 1 ELSE 0 END) AS lagging,
      SUM(CASE WHEN latest.updated_at IS NOT NULL
          AND latest.updated_at >= player_profiles.profile_updated_at THEN 1 ELSE 0 END) AS current,
      MAX(latest.updated_at) AS freshness_at
    FROM player_profiles
    LEFT JOIN latest ON latest.aid = player_profiles.aid
    WHERE player_profiles.mode = 'seasonal' AND player_profiles.cycle_id = ?
      AND player_profiles.confirmed_banned = 0
  `).get(cycleId, cycleId);
  const total = Number(row?.total) || 0;
  const current = Number(row?.current) || 0;
  return {
    total,
    missing: Number(row?.missing) || 0,
    lagging: Number(row?.lagging) || 0,
    current,
    coveragePercent: total === 0 ? 100 : Number(((current / total) * 100).toFixed(4)),
    freshnessAt: row?.freshness_at == null ? null : Number(row.freshness_at),
  };
}
