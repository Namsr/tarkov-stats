#!/usr/bin/env node

import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function nonNegativeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function counterValue(counters, key) {
  if (!counters) return null;
  if (Array.isArray(counters)) {
    const item = counters.find(({ Key }) =>
      Key === key || (Array.isArray(Key) && Key.length === 1 && Key[0] === key));
    return item ? nonNegativeInteger(item.Value) : null;
  }
  if (typeof counters !== "object") return null;
  if (Array.isArray(counters.Items)) return counterValue(counters.Items, key);
  return nonNegativeInteger(counters[key]);
}

export function bestArpFromArenaRaw(rawJson) {
  try {
    const raw = JSON.parse(String(rawJson ?? ""));
    return counterValue(raw?.sourceCounters?.Counters ?? raw?.sourceCounters, "BestArp");
  } catch {
    return null;
  }
}

function exactProfileFields(row) {
  try {
    const stats = JSON.parse(String(row.stats_json ?? ""));
    if (Number(stats?.profileUpdatedAt) !== Number(row.profile_updated_at)) return null;
    const exactTuple = stats?.pvpStatsVersion === 1 && stats?.pvpStatsKnown === true &&
      nonNegativeInteger(stats.pmcRaids) !== null && nonNegativeInteger(stats.pmcDeaths) !== null &&
      nonNegativeInteger(stats.pmcKilledPmc) !== null;
    const pvpStatsVersion = exactTuple ? 1 : 0;
    const pmcKilledPmc = exactTuple ? stats.pmcKilledPmc : null;
    const lastPlayedAt = positiveTimestamp(stats?.lastPlayedAt);
    return { pmcKilledPmc, lastPlayedAt, pvpStatsVersion };
  } catch {
    return null;
  }
}

export function backfillLeaderboardExactFields(db) {
  const summary = {
    pveScanned: 0,
    pveUpdated: 0,
    arenaScanned: 0,
    arenaUpdated: 0,
    regularPendingRefresh: 0,
  };
  db.exec("SAVEPOINT backfill_leaderboard_exact_fields");
  try {
    const pveRows = db.prepare(`SELECT aid, profile_updated_at, stats_json,
        pmc_killed_pmc, last_played_at, pvp_stats_version
      FROM mode_players
      WHERE mode = 'pve' AND (pmc_killed_pmc IS NULL OR last_played_at IS NULL)`).all();
    const updatePve = db.prepare(`UPDATE mode_players
      SET pmc_killed_pmc = COALESCE(pmc_killed_pmc, ?),
          last_played_at = COALESCE(last_played_at, ?),
          pvp_stats_version = MAX(pvp_stats_version, ?)
      WHERE mode = 'pve' AND aid = ? AND profile_updated_at = ?`);
    for (const row of pveRows) {
      summary.pveScanned += 1;
      const exact = exactProfileFields(row);
      if (!exact || (exact.pmcKilledPmc === null && exact.lastPlayedAt === null)) continue;
      const result = updatePve.run(
        exact.pmcKilledPmc,
        exact.lastPlayedAt,
        exact.pmcKilledPmc === null ? 0 : exact.pvpStatsVersion,
        row.aid,
        row.profile_updated_at,
      );
      if (Number(result.changes) > 0) summary.pveUpdated += 1;
    }

    for (const table of ["arena_mode_stats", "arena_mode_stats_history"]) {
      const rows = db.prepare(`SELECT aid, upstream_version, parser_version, raw_json
        FROM ${table} WHERE arena_mode = 'overall' AND best_arp IS NULL`).all();
      const update = db.prepare(`UPDATE ${table} SET best_arp = ?
        WHERE aid = ? AND arena_mode = 'overall' AND upstream_version = ?
          AND parser_version = ? AND best_arp IS NULL`);
      for (const row of rows) {
        summary.arenaScanned += 1;
        const bestArp = bestArpFromArenaRaw(row.raw_json);
        if (bestArp === null) continue;
        const result = update.run(bestArp, row.aid, row.upstream_version, row.parser_version);
        if (Number(result.changes) > 0) summary.arenaUpdated += 1;
      }
    }

    summary.regularPendingRefresh = Number(db.prepare(`SELECT COUNT(*) AS n FROM players
      WHERE pmc_killed_pmc IS NULL OR last_played_at IS NULL`).get()?.n) || 0;
    db.exec("RELEASE backfill_leaderboard_exact_fields");
    return summary;
  } catch (error) {
    db.exec("ROLLBACK TO backfill_leaderboard_exact_fields");
    db.exec("RELEASE backfill_leaderboard_exact_fields");
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const db = new DatabaseSync(process.env.SQLITE_PATH || "/data/players.db");
  db.exec("PRAGMA busy_timeout = 30000");
  try {
    console.log(JSON.stringify(backfillLeaderboardExactFields(db)));
  } finally {
    db.close();
  }
}
