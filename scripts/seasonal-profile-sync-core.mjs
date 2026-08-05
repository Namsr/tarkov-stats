import {
  createTimestampObjectParser,
  feedCacheSlot,
  normalizeUpdatedAt,
} from "./regular-profile-sync-core.mjs";

export { createTimestampObjectParser, feedCacheSlot, normalizeUpdatedAt };

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
  url.searchParams.set("v", new Date(now).toISOString().slice(0, 10));
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
