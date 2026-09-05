/* eslint-disable @typescript-eslint/no-explicit-any -- node:sqlite is loaded dynamically because the project's Node types predate it. */
import type { ArenaModeKey } from "@/types/arena";
import type { ArenaLeaderboardTab } from "@/types/leaderboard";
import type { LeaderboardScopeConfig } from "./config";
import type { LeaderboardSourceRow } from "./materialize";

function columns(db: any, table: string): Set<string> {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row: any) => String(row.name)));
}

function changeRevision(db: any, mode: "regular" | "pve" | "arena"): string {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='leaderboard_profile_changes'").get();
  return exists ? `(SELECT revision FROM leaderboard_profile_changes c WHERE c.mode='${mode}' AND c.aid=` : "";
}

function databaseAttached(db: any, name: string): boolean {
  return db.prepare("PRAGMA database_list").all().some((row: any) => String(row.name) === name);
}

function numberOrNull(value: unknown): number | null {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function integerOrNull(value: unknown): number | null {
  const number = numberOrNull(value);
  return number != null && Number.isSafeInteger(number) ? number : null;
}

function bestArpFromRaw(value: unknown): number | null {
  try {
    const raw = JSON.parse(String(value));
    const counters = raw?.sourceCounters?.Counters ?? raw?.sourceCounters;
    if (Array.isArray(counters?.Items)) {
      const item = counters.Items.find((entry: any) =>
        Array.isArray(entry?.Key) && entry.Key.length === 1 && entry.Key[0] === "BestArp");
      return numberOrNull(item?.Value);
    }
    return numberOrNull(counters?.BestArp);
  } catch {
    return null;
  }
}

function standardRows(db: any, config: LeaderboardScopeConfig, aid?: number): Iterable<LeaderboardSourceRow> {
  const table = config.mode === "regular" ? "players" : "mode_players";
  const cols = columns(db, table);
  const exact = cols.has("pmc_killed_pmc") ? "pmc_killed_pmc" : config.mode === "pve"
    ? "json_extract(stats_json, '$.pmcKilledPmc')" : "NULL";
  const lastPlayed = cols.has("last_played_at") ? "last_played_at" : config.mode === "pve"
    ? "json_extract(stats_json, '$.lastPlayedAt')" : "NULL";
  const pvpVersion = cols.has("pvp_stats_version") ? "pvp_stats_version" : config.mode === "pve"
    ? "COALESCE(json_extract(stats_json, '$.pvpStatsVersion'),0)" : "0";
  const mode = config.mode === "pve" ? "mode='pve' AND" : "";
  const revision = changeRevision(db, config.mode === "regular" ? "regular" : "pve");
  const sourceRevision = revision ? `${revision}${table}.aid)` : "0";
  const sql = `SELECT aid,nickname,profile_updated_at,${exact} exact_kills,pmc_deaths,pmc_raids,hours,
      ${lastPlayed} activity_at,pvp_stats_known,${pvpVersion} pvp_stats_version,COALESCE(${sourceRevision},0) source_revision
    FROM ${table} WHERE ${mode} NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid=${table}.aid)
      ${aid == null ? "" : `AND ${table}.aid=?`}
    ORDER BY aid`;
  return {
    *[Symbol.iterator]() {
      for (const row of db.prepare(sql).iterate(...(aid == null ? [] : [aid]))) {
        const version = Number(row.pvp_stats_version) || 0;
        const known = version >= 1 && Number(row.pvp_stats_known) === 1;
        yield {
          aid: Number(row.aid), nickname: String(row.nickname || "Unknown"),
          sourceUpdatedAt: Number(row.profile_updated_at) || 0, parserVersion: version,
          sourceRevision: Number(row.source_revision) || 0,
          activityAt: numberOrNull(row.activity_at), activitySource: numberOrNull(row.activity_at) == null ? null : "skill",
          matches: known ? integerOrNull(row.pmc_raids) : null, kills: known ? integerOrNull(row.exact_kills) : null,
          deaths: known ? integerOrNull(row.pmc_deaths) : null, hours: numberOrNull(row.hours),
          currentArp: null, bestArp: null,
        } satisfies LeaderboardSourceRow;
      }
    },
  };
}

function arenaRows(db: any, config: LeaderboardScopeConfig, aid?: number): Iterable<LeaderboardSourceRow> {
  const cols = columns(db, "arena_mode_stats");
  const best = cols.has("best_arp") ? "overall.best_arp" : "NULL";
  const current = cols.has("current_arp") ? "overall.current_arp" : "NULL";
  const gameplayColumn = ["gameplay_activity_at", "last_played_at"].find((name) => cols.has(name));
  const gameplay = gameplayColumn ? `mode_stats.${gameplayColumn}` : "NULL";
  const revision = changeRevision(db, "arena");
  const sourceRevision = revision ? `${revision}mode_stats.aid)` : "0";
  const sql = `SELECT mode_stats.aid,COALESCE(p.nickname,'Unknown') nickname,
      mode_stats.upstream_version,mode_stats.parser_version,mode_stats.fetched_at,
      ${gameplay} gameplay_activity_at,mode_stats.games_count,mode_stats.kills,mode_stats.deaths,
      overall.hours,mode_stats.kills_per_match,${best} best_arp,overall.raw_json best_arp_raw,${current} current_arp,
      COALESCE(${sourceRevision},0) source_revision
    FROM arena_mode_stats mode_stats
    JOIN arena_mode_stats overall ON overall.aid=mode_stats.aid AND overall.arena_mode='overall'
    LEFT JOIN mode_players p ON p.mode='arena' AND p.aid=mode_stats.aid
    WHERE mode_stats.arena_mode=?
      AND NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid=mode_stats.aid)
      ${aid == null ? "" : "AND mode_stats.aid=?"}
    ORDER BY mode_stats.aid`;
  return {
    *[Symbol.iterator]() {
      for (const row of db.prepare(sql).iterate(config.arenaMode, ...(aid == null ? [] : [aid]))) {
        const gameplayAt = numberOrNull(row.gameplay_activity_at);
        const fetchedAt = numberOrNull(row.fetched_at);
        yield {
          aid: Number(row.aid), nickname: String(row.nickname),
          sourceUpdatedAt: Number(row.upstream_version) || 0,
          sourceRevision: Number(row.source_revision) || 0,
          parserVersion: Number(row.parser_version) || 0,
          activityAt: gameplayAt ?? fetchedAt,
          activitySource: gameplayAt != null ? "gameplay_date" : fetchedAt != null ? "profile_check" : null,
          matches: integerOrNull(row.games_count), kills: integerOrNull(row.kills), deaths: integerOrNull(row.deaths),
          hours: numberOrNull(row.hours), currentArp: numberOrNull(row.current_arp),
          bestArp: numberOrNull(row.best_arp) ?? bestArpFromRaw(row.best_arp_raw),
        } satisfies LeaderboardSourceRow;
      }
    },
  };
}

function seasonalRows(db: any, config: LeaderboardScopeConfig, aid?: number): Iterable<LeaderboardSourceRow> {
  if (!config.cycleId) return [];
  const cols = columns(db, "player_profiles");
  const exactKills = cols.has("pmc_killed_pmc") ? "p.pmc_killed_pmc" : "NULL";
  const version = cols.has("pvp_stats_version") ? "p.pvp_stats_version" : "0";
  const parserVersion = cols.has("pvp_stats_parser_version") ? "p.pvp_stats_parser_version" : "0";
  const activity = cols.has("leaderboard_activity_at") ? "p.leaderboard_activity_at" : "NULL";
  const journal = db.prepare(`SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='leaderboard_seasonal_profile_changes'`).get();
  const revision = journal ? `(SELECT revision FROM leaderboard_seasonal_profile_changes c
    WHERE c.cycle_id=p.cycle_id AND c.aid=p.aid)` : "0";
  const globalExclusion = databaseAttached(db, "players_db")
    ? "AND NOT EXISTS (SELECT 1 FROM players_db.excluded_players e WHERE e.aid=p.aid)" : "";
  const sql = `SELECT p.aid,p.nickname,p.profile_updated_at,${exactKills} exact_kills,p.pmc_deaths,p.pmc_raids,
      p.lifetime_pvp_hours hours,${activity} activity_at,${version} pvp_stats_version,
      ${parserVersion} pvp_stats_parser_version,
      COALESCE(${revision},0) source_revision
    FROM player_profiles p
    WHERE p.mode='seasonal' AND p.cycle_id=? AND p.confirmed_banned=0
      AND NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid=p.aid) ${globalExclusion}
      ${aid == null ? "" : "AND p.aid=?"} ORDER BY p.aid`;
  return {
    *[Symbol.iterator]() {
      for (const row of db.prepare(sql).iterate(config.cycleId, ...(aid == null ? [] : [aid]))) {
        const known = Number(row.pvp_stats_version) >= 1;
        yield {
          aid: Number(row.aid), nickname: String(row.nickname || "Unknown"),
          sourceUpdatedAt: Number(row.profile_updated_at) || 0,
          sourceRevision: Number(row.source_revision) || 0,
          parserVersion: Number(row.pvp_stats_parser_version) || 0,
          activityAt: numberOrNull(row.activity_at), activitySource: numberOrNull(row.activity_at) == null ? null : "skill",
          matches: known ? integerOrNull(row.pmc_raids) : null,
          kills: known ? integerOrNull(row.exact_kills) : null,
          deaths: known ? integerOrNull(row.pmc_deaths) : null,
          hours: numberOrNull(row.hours), currentArp: null, bestArp: null,
        } satisfies LeaderboardSourceRow;
      }
    },
  };
}

export function leaderboardSourceRows(db: any, config: LeaderboardScopeConfig, aid?: number): Iterable<LeaderboardSourceRow> {
  if (config.mode === "arena") return arenaRows(db, config, aid);
  if (config.mode === "pvp-season") return seasonalRows(db, config, aid);
  return standardRows(db, config, aid);
}

export function arenaTabCounts(db: any): ArenaLeaderboardTab[] {
  const result = new Map<ArenaModeKey, number>();
  for (const row of db.prepare(`SELECT arena_mode,COUNT(DISTINCT aid) count FROM arena_mode_stats s
    WHERE arena_mode<>'overall' AND games_count IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid=s.aid) GROUP BY arena_mode`).all()) {
    result.set(String(row.arena_mode) as ArenaModeKey, Number(row.count) || 0);
  }
  const modes: ArenaModeKey[] = ["blastGang", "teamFight", "lastHero", "checkpoint", "shootOutDuo"];
  return modes.map((mode) => ({ mode, knownMatchProfiles: result.get(mode) ?? 0 })).sort((left, right) =>
    left.mode === "blastGang" ? -1 : right.mode === "blastGang" ? 1
      : right.knownMatchProfiles - left.knownMatchProfiles || left.mode.localeCompare(right.mode));
}

export function leaderboardChangeWindow(db: any, mode: "regular" | "pve" | "arena" | "pvp-season", afterChangeId: number,
  cycleId?: string | null): {
  cutoff: number;
  changes: { aid: number; revision: number }[];
} {
  if (mode === "pvp-season") {
    const exists = db.prepare(`SELECT 1 FROM sqlite_master
      WHERE type='table' AND name='leaderboard_seasonal_profile_changes'`).get();
    if (!exists || !cycleId) return { cutoff: afterChangeId, changes: [] };
    const cutoff = Number(db.prepare(`SELECT MAX(change_id) change_id
      FROM leaderboard_seasonal_profile_changes`).get()?.change_id ?? afterChangeId);
    const changes = db.prepare(`SELECT aid,revision FROM leaderboard_seasonal_profile_changes
      WHERE cycle_id=? AND change_id>? AND change_id<=? ORDER BY change_id`).all(cycleId, afterChangeId, cutoff)
      .map((row: any) => ({ aid: Number(row.aid), revision: Number(row.revision) }));
    return { cutoff, changes };
  }
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='leaderboard_profile_changes'").get();
  if (!exists) return { cutoff: afterChangeId, changes: [] };
  const cutoff = Number(db.prepare("SELECT MAX(change_id) change_id FROM leaderboard_profile_changes").get()?.change_id ?? afterChangeId);
  const changes = db.prepare(`SELECT aid,revision FROM leaderboard_profile_changes
    WHERE mode=? AND change_id>? AND change_id<=? ORDER BY change_id`).all(mode, afterChangeId, cutoff)
    .map((row: any) => ({ aid: Number(row.aid), revision: Number(row.revision) }));
  return { cutoff, changes };
}
