import type { ParsedPlayerStats } from "@/types/tarkov";
import { bracketFor } from "@/lib/brackets";
import { LEGACY_IDENTITY, type ProfileIdentity } from "@/types/seasonal";
import {
  FAVORITE_INSERT_SQL,
  FAVORITE_SET_MAIN_SQL,
  MAX_FAVORITES,
  favoriteInsertResult,
  initializeFavoritesSchema,
} from "@/lib/favorites-schema";
import { seasonalCandidateOrderParameters } from "@/lib/seasonal/scanner";
import type { GameMode } from "@/types/seasonal";
import type { ProfileSummary } from "@/lib/profile-summary";
import {
  COMPARISON_COHORT_PERCENTAGES,
  COMPARISON_COHORT_TARGET,
  COMPARISON_RADAR_METRICS,
  RISK_COHORT_TARGET,
  comparisonRangeFor,
  emptyComparisonAverages,
  makeComparisonCohortResult,
  selectComparisonPercent,
  type ComparisonActualRanges,
  type ComparisonCohortPercent,
  type ComparisonCohortResult,
} from "@/lib/profile-cohort";
import {
  initializeArenaSchema,
  upsertArenaSqlite,
} from "@/lib/arena/storage";
import {
  ACHIEVEMENT_BASELINE_PUBLICATION_SCHEMA,
  readPublishedAchievementBaseline,
} from "@/lib/achievement-baseline-publication";
import { initializeProfileChangeJournal } from "@/lib/profile-change-journal";

// The cohort and population scans filter on these five columns and read the
// radar metrics straight out of the index. Carrying them makes every cohort
// query index-only: without them SQLite resolved every matched or eligible row
// against the table B-tree one rowid lookup at a time, which is what pushed a
// Regular population fallback into whole seconds.
const COHORT_INDEX_COLS = "hours, pmc_raids, pvp_stats_known, profile_updated_at, aid";
const COHORT_INDEX_METRICS = [
  "kd_ratio",
  "pmc_kd_ratio",
  "kills_per_raid",
  "pmc_survival_rate",
  "longest_win_streak",
  "level",
];

// One row per collected player, keyed by account id. Re-looking up the same
// player UPDATES the row (counted once, always current). Uses a local SQLite
// file in the self-hosted Node/Docker runtime with --experimental-sqlite.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  aid INTEGER PRIMARY KEY,
  nickname TEXT, side TEXT, prestige INTEGER DEFAULT 0, level INTEGER DEFAULT 0,
  experience INTEGER DEFAULT 0, hours REAL DEFAULT 0, bracket_key TEXT,
  total_raids INTEGER DEFAULT 0, pmc_raids INTEGER DEFAULT 0, scav_raids INTEGER DEFAULT 0,
  survived INTEGER DEFAULT 0, deaths INTEGER DEFAULT 0, pmc_deaths INTEGER DEFAULT 0,
  total_kills INTEGER DEFAULT 0, killed_pmc INTEGER DEFAULT 0, pmc_killed_pmc INTEGER, run_through INTEGER DEFAULT 0,
  longest_win_streak INTEGER DEFAULT 0, kd_ratio REAL DEFAULT 0, pmc_kd_ratio REAL DEFAULT 0,
  survival_rate REAL DEFAULT 0, kills_per_raid REAL DEFAULT 0,
  pmc_survival_rate REAL DEFAULT 0, pmc_kills_per_raid REAL DEFAULT 0, achv_count INTEGER DEFAULT 0,
  achievements TEXT, profile_updated_at INTEGER DEFAULT 0, last_played_at INTEGER,
  pvp_stats_known INTEGER DEFAULT 0, pvp_stats_version INTEGER DEFAULT 0, fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_players_bracket ON players(bracket_key);
CREATE INDEX IF NOT EXISTS idx_players_hours ON players(hours);
CREATE INDEX IF NOT EXISTS idx_players_pmc_raids ON players(pmc_raids);
CREATE INDEX IF NOT EXISTS idx_players_cohort ON players(${COHORT_INDEX_COLS}, ${COHORT_INDEX_METRICS.join(", ")});
CREATE INDEX IF NOT EXISTS idx_players_cohort_regular ON players(pvp_stats_known, profile_updated_at, hours, pmc_raids);
CREATE INDEX IF NOT EXISTS idx_players_nickname_nocase ON players(nickname COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS mode_players (
  mode TEXT NOT NULL CHECK (mode IN ('pve', 'arena')),
  aid INTEGER NOT NULL,
  nickname TEXT, side TEXT, prestige INTEGER DEFAULT 0, level INTEGER DEFAULT 0,
  experience INTEGER DEFAULT 0, hours REAL DEFAULT 0, bracket_key TEXT,
  total_raids INTEGER DEFAULT 0, pmc_raids INTEGER DEFAULT 0, scav_raids INTEGER DEFAULT 0,
  survived INTEGER DEFAULT 0, deaths INTEGER DEFAULT 0, pmc_deaths INTEGER DEFAULT 0,
  total_kills INTEGER DEFAULT 0, killed_pmc INTEGER DEFAULT 0, pmc_killed_pmc INTEGER, run_through INTEGER DEFAULT 0,
  longest_win_streak INTEGER DEFAULT 0, kd_ratio REAL DEFAULT 0, pmc_kd_ratio REAL DEFAULT 0,
  survival_rate REAL DEFAULT 0, kills_per_raid REAL DEFAULT 0,
  pmc_survival_rate REAL DEFAULT 0, pmc_kills_per_raid REAL DEFAULT 0, achv_count INTEGER DEFAULT 0,
  achievements TEXT, profile_updated_at INTEGER DEFAULT 0, last_played_at INTEGER,
  pvp_stats_known INTEGER DEFAULT 0, pvp_stats_version INTEGER DEFAULT 0, fetched_at INTEGER NOT NULL, stats_json TEXT NOT NULL,
  PRIMARY KEY (mode, aid)
);
CREATE INDEX IF NOT EXISTS idx_mode_players_bracket ON mode_players(mode, bracket_key);
CREATE INDEX IF NOT EXISTS idx_mode_players_hours ON mode_players(mode, hours);
CREATE INDEX IF NOT EXISTS idx_mode_players_pmc_raids ON mode_players(mode, pmc_raids);
CREATE INDEX IF NOT EXISTS idx_mode_players_cohort ON mode_players(mode, ${COHORT_INDEX_COLS}, ${COHORT_INDEX_METRICS.join(", ")});

CREATE VIEW IF NOT EXISTS pve_players AS SELECT * FROM mode_players WHERE mode = 'pve';
CREATE VIEW IF NOT EXISTS arena_players AS SELECT * FROM mode_players WHERE mode = 'arena';

-- A small local tombstone makes removal durable even though the full ban data
-- lives in a separate database. It also closes the check-then-insert race.
CREATE TABLE IF NOT EXISTS excluded_players (
  aid INTEGER PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Игровые аккаунты, привязанные пользователем (вход через Google) в избранное.
-- Ключ — user_sub (стабильный Google-id из JWT-сессии) + aid. nickname хранится
-- снимком, чтобы рисовать список без обращения к tarkov.dev; обновляется при
-- "обновить все". is_main помечает основной аккаунт пользователя (ровно один).
CREATE TABLE IF NOT EXISTS favorites (
  user_sub TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'regular',
  cycle_id TEXT NOT NULL DEFAULT 'persistent',
  aid INTEGER NOT NULL,
  nickname TEXT, note TEXT, is_main INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_sub, aid)
);
CREATE INDEX IF NOT EXISTS idx_favorites_user_identity ON favorites(user_sub, mode, cycle_id);

-- Local snapshot of players.tarkov.dev/profile/index.json. This table is a
-- nickname directory only; profile statistics are still loaded on demand.
CREATE TABLE IF NOT EXISTS player_index (
  aid INTEGER PRIMARY KEY,
  nickname TEXT NOT NULL,
  nickname_lower TEXT NOT NULL,
  synced_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_player_index_nickname_lower ON player_index(nickname_lower);
CREATE TABLE IF NOT EXISTS player_index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- PvE keeps a separate nickname directory. The explicit mode key prevents a
-- future mode-aware reader from accidentally mixing it with the PvP index.
CREATE TABLE IF NOT EXISTS pve_player_index (
  mode TEXT NOT NULL CHECK (mode = 'pve'),
  aid INTEGER NOT NULL,
  nickname TEXT NOT NULL,
  nickname_lower TEXT NOT NULL,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (mode, aid)
);
CREATE INDEX IF NOT EXISTS idx_pve_player_index_nickname_lower
  ON pve_player_index(mode, nickname_lower, aid);
CREATE TABLE IF NOT EXISTS pve_player_index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Arena keeps the same isolated nickname-directory contract as PvE.
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
CREATE TABLE IF NOT EXISTS arena_player_index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
${ACHIEVEMENT_BASELINE_PUBLICATION_SCHEMA}
`;

const CURRENT_PLAYER_SCHEMA_OBJECTS = [
  "players", "idx_players_bracket", "idx_players_hours", "idx_players_pmc_raids", "idx_players_cohort",
  "idx_players_nickname_nocase", "idx_players_profile_updated_at", "idx_players_cohort_regular", "mode_players",
  "idx_mode_players_bracket", "idx_mode_players_hours", "idx_mode_players_pmc_raids", "idx_mode_players_cohort",
  "leaderboard_profile_changes", "idx_leaderboard_profile_changes_mode_change",
  "trg_players_leaderboard_change_insert", "trg_players_leaderboard_change_update",
  "trg_players_leaderboard_change_delete", "trg_mode_players_leaderboard_change_insert",
  "trg_mode_players_leaderboard_change_update", "trg_mode_players_leaderboard_change_delete",
  "pve_players", "arena_players", "excluded_players", "favorites",
  "idx_favorites_user_identity", "player_index", "idx_player_index_nickname_lower", "player_index_meta",
  "pve_player_index", "idx_pve_player_index_nickname_lower", "pve_player_index_meta",
  "arena_player_index", "idx_arena_player_index_nickname_lower", "arena_player_index_meta",
  "achievement_baseline_publications",
] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function currentSqlitePlayerSchema(db: any): boolean {
  const objects = new Set((db.prepare("SELECT name FROM sqlite_master").all() as { name: string }[])
    .map((row) => row.name));
  if (!CURRENT_PLAYER_SCHEMA_OBJECTS.every((name) => objects.has(name))) return false;

  for (const table of ["players", "mode_players"]) {
    const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
      .map((column) => column.name));
    if (!["pmc_survival_rate", "pmc_kills_per_raid", "profile_updated_at", "pvp_stats_known", "pvp_stats_version", "pmc_killed_pmc", "last_played_at"]
      .every((name) => columns.has(name))) return false;
  }
  const favorites = db.prepare("PRAGMA table_info(favorites)").all() as { name: string; pk: number }[];
  const primaryKey = favorites.filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk).map((column) => column.name).join(",");
  return favorites.some((column) => column.name === "mode") && primaryKey === "user_sub,aid";
}

const COLS = [
  "aid", "nickname", "side", "prestige", "level", "experience", "hours", "bracket_key",
  "total_raids", "pmc_raids", "scav_raids", "survived", "deaths", "pmc_deaths",
  "total_kills", "killed_pmc", "pmc_killed_pmc", "run_through", "longest_win_streak",
  "kd_ratio", "pmc_kd_ratio", "survival_rate", "kills_per_raid",
  "pmc_survival_rate", "pmc_kills_per_raid",
  "achv_count", "achievements", "profile_updated_at", "last_played_at", "pvp_stats_known", "pvp_stats_version", "fetched_at",
];
const SQLITE_UPSERT_SQL =
  `INSERT INTO players (${COLS.join(", ")}) ` +
  `SELECT ${COLS.map(() => "?").join(", ")} ` +
  `WHERE NOT EXISTS (SELECT 1 FROM excluded_players WHERE aid = ?) ` +
  `ON CONFLICT(aid) DO UPDATE SET ` +
  COLS.filter((c) => c !== "aid").map((c) => `${c} = excluded.${c}`).join(", ") +
  ` WHERE excluded.profile_updated_at > players.profile_updated_at OR ` +
  `(excluded.profile_updated_at = players.profile_updated_at AND excluded.pvp_stats_version >= players.pvp_stats_version)`;
const SQLITE_MODE_UPSERT_SQL =
  `INSERT INTO mode_players (mode, ${COLS.join(", ")}, stats_json) ` +
  `SELECT ?, ${COLS.map(() => "?").join(", ")}, ? ` +
  `WHERE NOT EXISTS (SELECT 1 FROM excluded_players WHERE aid = ?) ` +
  `ON CONFLICT(mode, aid) DO UPDATE SET ` +
  [...COLS.filter((c) => c !== "aid"), "stats_json"]
    .map((c) => `${c} = excluded.${c}`).join(", ") +
  ` WHERE excluded.profile_updated_at > mode_players.profile_updated_at OR ` +
  `(excluded.profile_updated_at = mode_players.profile_updated_at AND excluded.pvp_stats_version >= mode_players.pvp_stats_version)`;

export type CrossSectionMode = Exclude<GameMode, "seasonal">;
type PlayerTable = "players" | "pve_players" | "arena_players";

function tableFor(mode: CrossSectionMode): PlayerTable {
  return mode === "regular" ? "players" : `${mode}_players`;
}

function scopePlayerSql(sql: string, table: PlayerTable): string {
  return table === "players" ? sql : sql.replace(/\bplayers\b/g, table);
}

// Metrics averaged for the "average player portrait".
export const AVG_COLS = [
  "hours", "total_raids", "pmc_raids", "scav_raids", "survival_rate",
  "kd_ratio", "pmc_kd_ratio", "kills_per_raid", "total_kills", "deaths",
  "killed_pmc", "run_through", "longest_win_streak", "achv_count", "level", "prestige",
  "pmc_survival_rate",
];

export type RangeDimension = "hours" | "pmc_raids";
export type AverageStatistic = "trimmed_mean" | "median";
export type AveragePeriod = "all" | "90d";

export function parseAverageStatistic(value: string | null): AverageStatistic | null {
  if (value == null || value === "trimmed_mean") return "trimmed_mean";
  if (value === "median") return "median";
  return null;
}

export function parseAveragePeriod(value: string | null): AveragePeriod | null {
  if (value == null || value === "all") return "all";
  if (value === "90d") return "90d";
  return null;
}

// An absent or empty parameter means "no bound", but a malformed one is a
// client error. Returning the same null for both would silently drop the
// range filter and answer with whole-population statistics.
export function parseNonNegative(value: string | null): { value: number | null; valid: boolean } {
  if (value == null || value === "") return { value: null, valid: true };
  const number = Number(value);
  const valid = Number.isFinite(number) && number >= 0;
  return { value: valid ? number : null, valid };
}

export function parseDimension(value: string | null): RangeDimension | null {
  if (value == null || value === "hours") return "hours";
  if (value === "pmc_raids") return "pmc_raids";
  return null;
}

const RANGE_COLUMNS: Record<RangeDimension, "hours" | "pmc_raids"> = {
  hours: "hours",
  pmc_raids: "pmc_raids",
};

function rangeColumn(dimension: RangeDimension): "hours" | "pmc_raids" {
  return RANGE_COLUMNS[dimension];
}

const PVP_METRICS = new Set(["pmc_kd_ratio", "killed_pmc"]);

function appendCondition(where: string, condition: string): string {
  return where ? `${where} AND ${condition}` : `WHERE ${condition}`;
}

function averagePeriodWhere(
  mode: CrossSectionMode,
  period: AveragePeriod,
  where: string,
  cutoff?: number,
): string {
  const active = appendCondition(
    where,
    "NOT EXISTS (SELECT 1 FROM excluded_players tombstone WHERE tombstone.aid = players.aid)"
  );
  if (period === "all") return active;
  const resolvedCutoff = cutoff ?? Math.floor(Date.now() - 90 * 86_400_000);
  return appendCondition(active, `profile_updated_at >= ${resolvedCutoff}`);
}

function eligibleMetricWhere(
  mode: CrossSectionMode,
  metric: string,
  where: string,
): string {
  if (metric && !/^[a-z_]+$/.test(metric)) {
    throw new Error(`invalid metric column: ${metric}`);
  }
  const populated = metric ? appendCondition(where, `${metric} IS NOT NULL`) : where;
  return mode === "regular" && PVP_METRICS.has(metric)
    ? appendCondition(populated, "pvp_stats_known = 1")
    : populated;
}
// Per-playtime-bracket aggregate: player count plus, optionally, the SUM of a
// chosen metric column (so the caller can derive a weighted average per bracket
// when adjacent brackets are merged). `column` is whitelisted by the caller and
// re-checked here — column names cannot be bound parameters, so it is inlined.
function aggSql(column: string | null, where = ""): string {
  if (column != null && !/^[a-z_]+$/.test(column)) {
    throw new Error(`invalid metric column: ${column}`);
  }
  const sumExpr = column ? `COALESCE(SUM(${column}), 0)` : "0";
  return (
    `SELECT bracket_key, COUNT(*) AS n, ${sumExpr} AS s ` +
    `FROM players ${where} GROUP BY bracket_key ORDER BY MIN(hours)`
  );
}

function bucketAggSql(
  dimension: RangeDimension,
  column: string | null,
  where = "",
  statistic: AverageStatistic = "trimmed_mean",
): string {
  if (column != null && !/^[a-z_]+$/.test(column)) {
    throw new Error(`invalid metric column: ${column}`);
  }
  const dimensionColumn = rangeColumn(dimension);
  const loExpr = dimension === "hours"
    ? `CASE WHEN ${dimensionColumn} >= 10000 THEN 10000 ` +
      `WHEN ${dimensionColumn} < 2000 THEN CAST(${dimensionColumn} / 50 AS INTEGER) * 50 ` +
      `ELSE 2000 + CAST((${dimensionColumn} - 2000) / 100 AS INTEGER) * 100 END`
    : `CASE WHEN ${dimensionColumn} >= 3000 THEN 3000 ` +
      `WHEN ${dimensionColumn} < 1000 THEN CAST(${dimensionColumn} / 25 AS INTEGER) * 25 ` +
      `ELSE 1000 + CAST((${dimensionColumn} - 1000) / 50 AS INTEGER) * 50 END`;
  const hiExpr = dimension === "hours"
    ? `CASE WHEN ${dimensionColumn} >= 10000 THEN NULL ` +
      `WHEN ${dimensionColumn} < 2000 THEN ${loExpr} + 50 ELSE ${loExpr} + 100 END`
    : `CASE WHEN ${dimensionColumn} >= 3000 THEN NULL ` +
      `WHEN ${dimensionColumn} < 1000 THEN ${loExpr} + 25 ELSE ${loExpr} + 50 END`;
  const sumExpr = column ? `COALESCE(SUM(${column}), 0)` : "0";
  if (column && statistic === "median") {
    return `WITH bucketed AS (
      SELECT ${loExpr} AS lo, ${hiExpr} AS hi, ${column} AS value
      FROM players ${where}
    ), ranked AS (
      SELECT lo, hi, value,
        ROW_NUMBER() OVER (PARTITION BY lo, hi ORDER BY value) AS rn,
        COUNT(*) OVER (PARTITION BY lo, hi) AS bucket_n
      FROM bucketed
    ) SELECT lo, hi, MAX(bucket_n) AS n,
      COALESCE(SUM(CASE WHEN rn IN (
        CAST((bucket_n + 1) / 2 AS INTEGER), CAST((bucket_n + 2) / 2 AS INTEGER)
      ) THEN value END) / NULLIF(COUNT(CASE WHEN rn IN (
        CAST((bucket_n + 1) / 2 AS INTEGER), CAST((bucket_n + 2) / 2 AS INTEGER)
      ) THEN 1 END), 0) * MAX(bucket_n), 0) AS s
      FROM ranked GROUP BY lo, hi ORDER BY lo`;
  }
  return (
    `SELECT ${loExpr} AS lo, ${hiExpr} AS hi, COUNT(*) AS n, ${sumExpr} AS s ` +
    `FROM players ${where} GROUP BY ${loExpr}, ${hiExpr} ORDER BY lo`
  );
}

function toBracketAggs(rows: { bracket_key: string; n: number; s: number }[]): BracketAgg[] {
  return rows.map((r) => ({ bracket_key: r.bracket_key, n: Number(r.n), sum: Number(r.s) }));
}

function toBucketAggs(rows: { lo: number; hi: number | null; n: number; s: number }[]): BucketAgg[] {
  return rows.map((r) => ({
    lo: Number(r.lo),
    hi: r.hi == null ? null : Number(r.hi),
    n: Number(r.n),
    sum: Number(r.s),
  }));
}

// Per-achievement baseline: for every achievement seen in the sample, how many
// players own it and the mean/variance of THEIR playtime. `json_each` expands the
// stored achievement-id array (one virtual row per id per player); grouping gives
// owner count plus the moments needed for a (hours) z-score. mean_sq lets us
// derive variance = mean_sq − mean² in one pass (Welford-free, good enough here).
// achievements is always valid JSON (we write JSON.stringify of an array), but we
// guard NULL/'' to be safe against any legacy rows.
// Кап на рост таблицы: после лимита новые aid не добавляются (существующие
// продолжают обновляться). Защищает диск VPS и датасет /average от
// автоматического наполнения ботами. 0 = без лимита.
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS ?? 200_000) || 0;

// Лимит избранного на пользователя — защита от раздувания таблицы одним аккаунтом.

// Робастный портрет среднего игрока: по КАЖДОЙ метрике отбрасываем по TRIM_FRACTION
// с обоих хвостов (триммированное среднее), чтобы читеры/боты с экстремальными
// статами не задирали "среднее". Триммируется каждая метрика независимо (отрезаются
// её собственные хвосты, а не "топ-игроки" целиком). На малой выборке
// (< MIN_N_FOR_TRIM) обрезка убрала бы слишком много — откат на обычное AVG.
const TRIM_FRACTION = 0.05;
const MIN_N_FOR_TRIM = 20;

function countSql(where: string): string {
  return `SELECT COUNT(*) AS n FROM players ${where}`;
}

// One statistic for one metric in a range. The trimmed mean preserves the
// existing LIMIT/OFFSET behavior; median ranks the populated values per metric.
function metricStatisticSql(
  column: string,
  where: string,
  statistic: AverageStatistic,
  trim: boolean,
): string {
  if (!/^[a-z_]+$/.test(column)) {
    throw new Error(`invalid metric column: ${column}`);
  }
  if (statistic === "median") {
    return (
      `WITH ranked AS (` +
      `SELECT ${column} AS v, ROW_NUMBER() OVER (ORDER BY ${column}) AS rn, ` +
      `COUNT(*) OVER () AS n FROM players ${where}` +
      `${where ? " AND" : " WHERE"} ${column} IS NOT NULL` +
      `) SELECT AVG(v) AS a FROM ranked ` +
      `WHERE rn IN (CAST((n + 1) / 2 AS INTEGER), CAST((n + 2) / 2 AS INTEGER))`
    );
  }
  if (!trim) return `SELECT AVG(${column}) AS a FROM players ${where}`;
  return (
    `SELECT AVG(v) AS a FROM ` +
    `(SELECT ${column} AS v FROM players ${where} ORDER BY ${column} LIMIT ? OFFSET ?)`
  );
}

// Self-contained trimmed mean for a single playtime range. Unlike
// metricStatisticSql(), this query derives n inside the same statement, which keeps
// the trim window consistent even while the background importer is adding
// players. It is used for the final, already-pooled histogram bins.
function histogramAvgSql(column: string, where: string): string {
  if (!AVG_COLS.includes(column) || !/^[a-z_]+$/.test(column)) {
    throw new Error(`invalid metric column: ${column}`);
  }
  return (
    `WITH ranked AS (` +
    `SELECT COALESCE(${column}, 0) AS v, ` +
    `ROW_NUMBER() OVER (ORDER BY COALESCE(${column}, 0)) AS rn, ` +
    `COUNT(*) OVER () AS n ` +
    `FROM players ${where}` +
    `), trimmed AS (` +
    `SELECT v, rn, n, ` +
    `CASE WHEN n >= ${MIN_N_FOR_TRIM} THEN CAST(n * ${TRIM_FRACTION} AS INTEGER) ELSE 0 END AS off ` +
    `FROM ranked` +
    `) ` +
    `SELECT AVG(v) AS a FROM trimmed WHERE rn > off AND rn <= n - off`
  );
}

// Окно обрезки для выборки размера n: смещение хвоста и сколько строк взять из
// середины. Возвращает trim=false (off=0) для малой выборки — тогда считаем
// обычное среднее по всему диапазону.
function trimWindow(n: number): { trim: boolean; off: number; lim: number } {
  if (n < MIN_N_FOR_TRIM) return { trim: false, off: 0, lim: n };
  const off = Math.floor(n * TRIM_FRACTION);
  if (off <= 0) return { trim: false, off: 0, lim: n };
  return { trim: true, off, lim: n - 2 * off };
}

function emptyAverageRow(): AverageRow {
  const row: AverageRow = { n: 0, metricCounts: {} };
  for (const c of AVG_COLS) {
    row[c] = null;
    row.metricCounts[c] = 0;
  }
  return row;
}

// SQLite runs the cohort aggregates on the web process, synchronously, so every
// row the plan cannot read from an index becomes a table B-tree lookup inside a
// query that blocks all other responses. The cohort and population scans filter
// on these five columns and average the radar metrics, so carrying all of them
// keeps the scan inside the index.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ensureSqliteCohortIndexes(db: any): void {
  const metrics = COHORT_INDEX_METRICS.join(", ");
  ensureIndexDefinition(
    db,
    "idx_players_cohort",
    `CREATE INDEX idx_players_cohort ON players(${COHORT_INDEX_COLS}, ${metrics})`,
  );
  ensureIndexDefinition(
    db,
    "idx_mode_players_cohort",
    `CREATE INDEX idx_mode_players_cohort ON mode_players(mode, ${COHORT_INDEX_COLS}, ${metrics})`,
  );
}

// `CREATE INDEX IF NOT EXISTS` keeps an existing index even when its definition
// no longer matches, so widening one of these on a live database needs an
// explicit rebuild. Comparing the stored DDL keeps that to a single
// sqlite_master read per open instead of a schema-version bump, and the rebuild
// is a no-op once the definition matches.
function normalizedIndexDdl(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ensureIndexDefinition(db: any, name: string, ddl: string): void {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?"
  ).get(name) as { sql?: string | null } | undefined;
  const stored = typeof row?.sql === "string" ? row.sql : null;
  if (stored !== null && normalizedIndexDdl(stored) === normalizedIndexDdl(ddl)) return;
  db.exec(`DROP INDEX IF EXISTS ${name}`);
  db.exec(ddl);
}

// SQLite executes the trimmed/median portrait on the web process. Covering the
// ORDER BY columns avoids a temporary sort for every metric and keeps a cold
// average request from blocking unrelated HTTP responses.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ensureSqliteAverageIndexes(db: any): void {
  for (const column of AVG_COLS) {
    if (!/^[a-z_]+$/.test(column)) throw new Error(`invalid average index column: ${column}`);
    if (column === "hours" || column === "pmc_raids") continue;
    db.exec(`CREATE INDEX IF NOT EXISTS idx_players_average_${column} ON players(${column})`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mode_players_average_${column} ON mode_players(mode, ${column})`);
  }
}

// Signals scored for "cheating risk" (suspicious when high). The baseline returns
// the mean + std of each within a playtime range, for within-bracket z-scores.
// PMC-only — keep in sync with SIGNALS in lib/cheater-score.ts.
const SCORE_COLS = ["pmc_survival_rate", "pmc_kd_ratio", "pmc_kills_per_raid", "longest_win_streak"];

// Per metric: the populated count plus AVG(col) and AVG(col*col), so std =
// sqrt(E[x²] − E[x]²) is one pass. Mean/std/count are taken ONLY over rows where the
// metric is populated (value > 0): a column still backfilling (0 until a profile is
// re-fetched) would otherwise drag the mean to ~0 and make every real value look like
// an extreme outlier. cnt_ lets the score decide whether to trust this metric's
// z-score yet. Columns are whitelisted constants, re-checked here because column names
// cannot be bound parameters.
function baselineSql(where: string): string {
  const cols = SCORE_COLS.map((c) => {
    if (!/^[a-z_]+$/.test(c)) throw new Error(`invalid metric column: ${c}`);
    return (
      `COUNT(CASE WHEN ${c} > 0 THEN 1 END) AS cnt_${c}, ` +
      `AVG(CASE WHEN ${c} > 0 THEN ${c} END) AS m_${c}, ` +
      `AVG(CASE WHEN ${c} > 0 THEN ${c} * ${c} END) AS sq_${c}`
    );
  }).join(", ");
  return `SELECT COUNT(*) AS n, ${cols} FROM players ${appendCondition(
    where,
    "NOT EXISTS (SELECT 1 FROM excluded_players tombstone WHERE tombstone.aid = players.aid)"
  )}`;
}

function toBaseline(row: Record<string, number> | null | undefined): BaselineResult {
  const metrics: Record<string, MetricBaseline> = {};
  for (const c of SCORE_COLS) {
    const mean = Number(row?.[`m_${c}`] ?? 0) || 0;
    const sq = Number(row?.[`sq_${c}`] ?? 0) || 0;
    const cnt = Number(row?.[`cnt_${c}`] ?? 0) || 0;
    metrics[c] = { n: cnt, mean, std: Math.sqrt(Math.max(0, sq - mean * mean)) };
  }
  return { n: Number(row?.n ?? 0), metrics };
}

function legacyHoursRangeClause(min: number | null, max: number | null): { where: string; params: number[] } {
  const conds: string[] = [];
  const params: number[] = [];
  if (min != null) { conds.push("hours >= ?"); params.push(min); }
  if (max != null) { conds.push("hours < ?"); params.push(max); }
  return { where: conds.length ? "WHERE " + conds.join(" AND ") : "", params };
}

function statRangeClause(range: StatRange): { where: string; params: number[] } {
  const column = rangeColumn(range.dimension);
  const conds: string[] = [];
  const params: number[] = [];
  if (range.requirePositive) conds.push(`${column} > 0`);
  if (range.min != null) { conds.push(`${column} >= ?`); params.push(range.min); }
  if (range.max != null) {
    conds.push(`${column} ${range.maxInclusive === false ? "<" : "<="} ?`);
    params.push(range.max);
  }
  if (range.excludeAid != null) { conds.push("aid != ?"); params.push(range.excludeAid); }
  return { where: conds.length ? "WHERE " + conds.join(" AND ") : "", params };
}

const COHORT_PERCENTAGES = [10, 15, 20, 25, 30] as const;
const COHORT_TARGET = 20;
const RADAR_COLS = [
  "kd_ratio",
  "pmc_kd_ratio",
  "kills_per_raid",
  "pmc_survival_rate",
  "longest_win_streak",
  "level",
] as const;

function cohortBounds(dimension: RangeDimension, center: number, percent: number): CohortBounds {
  const ratio = percent / 100;
  if (dimension === "hours") {
    return {
      min: Math.max(0, Math.floor(center * (1 - ratio) * 10) / 10),
      max: Math.ceil(center * (1 + ratio) * 10) / 10,
    };
  }
  return {
    min: Math.max(0, Math.floor(center * (1 - ratio))),
    max: Math.ceil(center * (1 + ratio)),
  };
}

function cohortCountSql(
  dimension: RangeDimension,
  ranges: { percent: CohortPercent; bounds: CohortBounds }[],
  where: string,
): string {
  const column = rangeColumn(dimension);
  const counts = ranges.map(
    ({ percent }) => `SUM(CASE WHEN ${column} >= ? AND ${column} <= ? THEN 1 ELSE 0 END) AS n${percent}`
  ).join(", ");
  return `SELECT MAX(${column}) AS max_value, ${counts} FROM players ${where}`;
}

function uniqueCohortRanges(dimension: RangeDimension, center: number) {
  const seen = new Set<string>();
  return COHORT_PERCENTAGES.flatMap((percent) => {
    const bounds = cohortBounds(dimension, center, percent);
    const key = `${bounds.min}:${bounds.max}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ percent, bounds }];
  });
}

function populatedMetricClause(
  mode: CrossSectionMode,
  metric: string,
  where: string,
): string {
  const eligible = eligibleMetricWhere(mode, metric, where);
  return metric === "pmc_survival_rate"
    ? appendCondition(eligible, "pmc_survival_rate > 0")
    : eligible;
}

function cohortEligibilityWhere(mode: CrossSectionMode, where: string): string {
  return mode === "regular"
    ? appendCondition(where, "pvp_stats_known = 1")
    : where;
}

function cohortSelectionPeriod(
  mode: CrossSectionMode,
  period: AveragePeriod,
): AveragePeriod {
  return mode === "regular" ? "90d" : period;
}

function emptyCohortMetrics(): Record<RadarMetric, CohortMetric> {
  return Object.fromEntries(
    RADAR_COLS.map((metric) => [metric, { value: null, count: 0 }])
  ) as Record<RadarMetric, CohortMetric>;
}

function unavailableCohort(
  dimension: RangeDimension,
  center: number,
  percent: CohortPercent,
  bounds: CohortBounds,
  n: number,
  reason: CohortUnavailableReason
): CohortResult {
  return {
    dimension,
    center,
    target: COHORT_TARGET,
    required: COHORT_TARGET,
    targetN: COHORT_TARGET,
    percent,
    bounds,
    n,
    strategy: "matched",
    quality: "unavailable",
    reason,
    averages: emptyCohortMetrics(),
  };
}

type CohortFirstReader = (sql: string, params: unknown[]) => Promise<Record<string, unknown> | null>;
type CohortAllReader = (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

function twoDimensionalPopulationWhere(
  mode: Extract<CrossSectionMode, "regular" | "pve">,
  excludeAid: number,
  period: AveragePeriod,
): { where: string; params: unknown[] } {
  const cutoff = Math.floor(Date.now() - 90 * 86_400_000);
  return {
    where: cohortEligibilityWhere(
      mode,
      averagePeriodWhere(
        mode,
        cohortSelectionPeriod(mode, period),
        "WHERE hours > 0 AND pmc_raids > 0 AND aid != ?",
        cutoff,
      ),
    ),
    params: [excludeAid],
  };
}

function twoDimensionalRangeWhere(
  mode: Extract<CrossSectionMode, "regular" | "pve">,
  center: { hours: number; pmcRaids: number },
  percent: ComparisonCohortPercent,
  excludeAid: number,
  period: AveragePeriod,
): { where: string; params: unknown[] } {
  const range = comparisonRangeFor(center, percent);
  const population = twoDimensionalPopulationWhere(mode, excludeAid, period);
  return {
    where: appendCondition(
      population.where,
      "hours >= ? AND hours <= ? AND pmc_raids >= ? AND pmc_raids <= ?",
    ),
    params: [...population.params, range.hours.min, range.hours.max, range.pmcRaids.min, range.pmcRaids.max],
  };
}

function persistentComparisonMetricsSql(where: string, statistic: AverageStatistic): string {
  const selected = statistic === "median"
    ? "rn IN (CAST((n + 1) / 2 AS INTEGER), CAST((n + 2) / 2 AS INTEGER))"
    : `rn > CASE WHEN n >= ${MIN_N_FOR_TRIM} THEN CAST(n * ${TRIM_FRACTION} AS INTEGER) ELSE 0 END
       AND rn <= n - CASE WHEN n >= ${MIN_N_FOR_TRIM} THEN CAST(n * ${TRIM_FRACTION} AS INTEGER) ELSE 0 END`;
  // One ranked pass per metric over the shared cohort CTE. Ranking the six
  // metrics together meant a UNION ALL that expanded the cohort six times first,
  // so the statement wrote and then sorted six figures worth of rows. That is
  // cheap for a matched window of a few hundred rows and ruinous for the
  // population fallback, which has no window and aggregates every eligible row.
  // Ranking each metric on its own keeps the cohort at one row per player.
  const perMetric = COMPARISON_RADAR_METRICS.map((metric) =>
    `SELECT '${metric}' AS metric, MAX(n) AS n,
      AVG(CASE WHEN ${selected} THEN v END) AS a, NULL, NULL, NULL, NULL
      FROM (SELECT ${metric} AS v, ROW_NUMBER() OVER (ORDER BY ${metric}) AS rn,
        COUNT(*) OVER () AS n FROM cohort WHERE ${metric} IS NOT NULL${
      metric === "pmc_survival_rate" ? " AND pmc_survival_rate > 0" : ""
    })`
  ).join("\n    UNION ALL\n    ");
  return `WITH cohort AS (
    SELECT hours, pmc_raids, ${COMPARISON_RADAR_METRICS.join(", ")} FROM players ${where}
  )
  SELECT '__group__' AS metric, COUNT(*) AS n, NULL AS a,
    MIN(hours) AS hours_min, MAX(hours) AS hours_max,
    MIN(pmc_raids) AS raids_min, MAX(pmc_raids) AS raids_max
  FROM cohort
  UNION ALL
  ${perMetric}`;
}

async function computePersistentTwoDimensionalCohort(input: {
  mode: Extract<CrossSectionMode, "regular" | "pve">;
  center: { hours: number; pmcRaids: number };
  excludeAid: number;
  dimension: "hours" | "pmc_raids";
  statistic: AverageStatistic;
  period: AveragePeriod;
  readFirst: CohortFirstReader;
  readAll: CohortAllReader;
}): Promise<ComparisonCohortResult> {
  const { center } = input;
  if (
    !Number.isFinite(center.hours) ||
    !Number.isFinite(center.pmcRaids) ||
    center.hours <= 0 ||
    center.pmcRaids <= 0
  ) {
    return makeComparisonCohortResult({
      mode: input.mode,
      cycleId: LEGACY_IDENTITY.cycleId,
      aid: input.excludeAid,
      center,
      dimension: input.dimension,
      percent: 30,
      n: 0,
      actualRanges: { hours: null, pmcRaids: null, raids: null },
      reason: "no_activity",
    });
  }

  const widest = twoDimensionalRangeWhere(input.mode, center, 30, input.excludeAid, input.period);
  const countRanges = COMPARISON_COHORT_PERCENTAGES.map((percent) => comparisonRangeFor(center, percent));
  const countRow = await input.readFirst(
    `SELECT ${COMPARISON_COHORT_PERCENTAGES.map((percent) =>
      `SUM(CASE WHEN hours >= ? AND hours <= ? AND pmc_raids >= ? AND pmc_raids <= ? THEN 1 ELSE 0 END) AS count_${percent}`
    ).join(", ")} FROM players ${widest.where}`,
    [
      ...countRanges.flatMap((range) => [range.hours.min, range.hours.max, range.pmcRaids.min, range.pmcRaids.max]),
      ...widest.params,
    ],
  );
  const counts = Object.fromEntries(COMPARISON_COHORT_PERCENTAGES.map((percent) => [
    percent,
    Number(countRow?.[`count_${percent}`] ?? 0),
  ])) as Record<ComparisonCohortPercent, number>;
  const selectedPercent = selectComparisonPercent(counts, COMPARISON_COHORT_TARGET);
  const mode = input.mode;
  const matched = counts[selectedPercent] >= COMPARISON_COHORT_TARGET;
  // A matched window the counts already show is too small would be aggregated and
  // then thrown away, so the population slice is read instead. The seasonal
  // cohort picks its slice up front for the same reason.
  const selected = !matched && (mode === "regular" || mode === "pve")
    ? twoDimensionalPopulationWhere(mode, input.excludeAid, input.period)
    : twoDimensionalRangeWhere(mode, center, selectedPercent, input.excludeAid, input.period);
  const resultRows = await input.readAll(
    persistentComparisonMetricsSql(selected.where, input.statistic),
    selected.params,
  );
  const group = resultRows.find((row) => row.metric === "__group__");
  const n = Number(group?.n ?? 0);
  const strategy: "matched" | "population" | null = matched
    ? "matched"
    : n > 0 && (mode === "regular" || mode === "pve") ? "population" : null;
  const actualRanges: ComparisonActualRanges = {
    hours: group?.hours_min == null || group?.hours_max == null
      ? null
      : { min: Number(group.hours_min), max: Number(group.hours_max) },
    pmcRaids: group?.raids_min == null || group?.raids_max == null
      ? null
      : { min: Number(group.raids_min), max: Number(group.raids_max) },
    raids: group?.raids_min == null || group?.raids_max == null
      ? null
      : { min: Number(group.raids_min), max: Number(group.raids_max) },
  };
  if (strategy === null) {
    return makeComparisonCohortResult({
      mode: input.mode,
      cycleId: LEGACY_IDENTITY.cycleId,
      aid: input.excludeAid,
      center,
      dimension: input.dimension,
      percent: 30,
      n,
      actualRanges,
      strategy: input.mode === "regular" || input.mode === "pve" ? "population" : "matched",
      reason: "insufficient_cohort",
    });
  }

  const metricRows = new Map(resultRows.map((row) => [String(row.metric), row]));
  const averages = emptyComparisonAverages();
  for (const metric of COMPARISON_RADAR_METRICS) {
    const row = metricRows.get(metric);
    const count = Number(row?.n ?? 0);
    const minimumPopulatedCount = strategy === "population" || metric === "pmc_survival_rate" ? 1 : COMPARISON_COHORT_TARGET;
    if (count < minimumPopulatedCount) {
      averages[metric] = { value: null, count };
      continue;
    }
    averages[metric] = { value: row?.a == null ? null : Number(row.a), count };
  }
  return makeComparisonCohortResult({
    mode: input.mode,
    cycleId: LEGACY_IDENTITY.cycleId,
    aid: input.excludeAid,
    center,
    dimension: input.dimension,
    percent: strategy === "population" ? 30 : selectedPercent,
    n,
    actualRanges,
    averages,
    strategy: strategy ?? "matched",
  });
}

async function computePersistentRiskBaseline(input: {
  mode: Extract<CrossSectionMode, "regular" | "pve">;
  center: { hours: number; pmcRaids: number };
  excludeAid: number;
  period: AveragePeriod;
  readFirst: CohortFirstReader;
}): Promise<BaselineResult> {
  const widest = twoDimensionalRangeWhere(input.mode, input.center, 30, input.excludeAid, input.period);
  const ranges = COMPARISON_COHORT_PERCENTAGES.map((percent) => comparisonRangeFor(input.center, percent));
  const countRow = await input.readFirst(
    `SELECT ${COMPARISON_COHORT_PERCENTAGES.map((percent) =>
      `SUM(CASE WHEN hours >= ? AND hours <= ? AND pmc_raids >= ? AND pmc_raids <= ? THEN 1 ELSE 0 END) AS count_${percent}`
    ).join(", ")} FROM players ${widest.where}`,
    [
      ...ranges.flatMap((range) => [range.hours.min, range.hours.max, range.pmcRaids.min, range.pmcRaids.max]),
      ...widest.params,
    ],
  );
  const counts = Object.fromEntries(COMPARISON_COHORT_PERCENTAGES.map((percent) => [
    percent,
    Number(countRow?.[`count_${percent}`] ?? 0),
  ])) as Record<ComparisonCohortPercent, number>;
  const selectedPercent = selectComparisonPercent(counts, RISK_COHORT_TARGET);
  const selected = counts[selectedPercent] >= RISK_COHORT_TARGET
    ? twoDimensionalRangeWhere(input.mode, input.center, selectedPercent, input.excludeAid, input.period)
    : twoDimensionalPopulationWhere(input.mode, input.excludeAid, input.period);
  let row = await input.readFirst(baselineSql(selected.where), selected.params) as Record<string, number> | null;
  let baseline = toBaseline(row);
  if (counts[selectedPercent] >= RISK_COHORT_TARGET && baseline.n < RISK_COHORT_TARGET) {
    const population = twoDimensionalPopulationWhere(input.mode, input.excludeAid, input.period);
    row = await input.readFirst(baselineSql(population.where), population.params) as Record<string, number> | null;
    baseline = toBaseline(row);
  }
  return baseline;
}

function argsFor(aid: number, s: ParsedPlayerStats, achievementIds: string[], now: number): unknown[] {
  return [
    aid, s.nickname, s.side, s.prestige, s.level, s.experience, s.hoursPlayed,
    bracketFor(s.hoursPlayed).key, s.totalRaids, s.pmcRaids, s.scavRaids, s.survivedRaids,
    s.deaths, s.pmcDeaths, s.totalKills, s.killedPmc, s.pmcKilledPmc, s.runThrough, s.longestWinStreak,
    s.kdRatio, s.pmcKdRatio, s.survivalRate, s.killsPerRaid,
    s.pmcSurvivalRate, s.pmcKillsPerRaid, s.achievementsCount,
    JSON.stringify(achievementIds), Number(s.profileUpdatedAt) || 0,
    typeof s.lastPlayedAt === "number" && Number.isFinite(s.lastPlayedAt) && s.lastPlayedAt > 0
      ? s.lastPlayedAt
      : null,
    s.pvpStatsKnown === true ? 1 : 0,
    Number.isSafeInteger(s.pvpStatsVersion) && Number(s.pvpStatsVersion) >= 0 ? Number(s.pvpStatsVersion) : 0,
    now,
  ];
}

export interface AverageRow {
  n: number;
  metricCounts: Record<string, number>;
  [metric: string]: number | null | Record<string, number>;
}
export interface StatRange {
  dimension: RangeDimension;
  min: number | null;
  max: number | null;
  /** New API ranges are inclusive; legacy hour ranges explicitly set this false. */
  maxInclusive?: boolean;
  excludeAid?: number;
  /** Exclude rows with zero activity in the selected dimension (cohort queries). */
  requirePositive?: boolean;
}
export interface BracketAgg {
  /** Playtime bracket, e.g. "0-50" or "10000+". */
  bracket_key: string;
  /** Players in the bracket. */
  n: number;
  /** SUM of the selected metric column over the bracket (0 in count mode). */
  sum: number;
}
export interface BucketAgg {
  lo: number;
  /** null denotes the open-ended top bucket. Other bucket highs are exclusive. */
  hi: number | null;
  n: number;
  /** Additive metric sum, or statistic*n for a median distribution. */
  sum: number;
}
export interface RangeBounds {
  min: number;
  max: number;
}
export type RadarMetric = (typeof RADAR_COLS)[number];
export type CohortPercent = (typeof COHORT_PERCENTAGES)[number];
export interface CohortBounds {
  min: number;
  max: number;
}
export interface CohortMetric {
  value: number | null;
  count: number;
}
export type CohortUnavailableReason =
  | "no_activity"
  | "above_coverage"
  | "insufficient_similar_hours"
  | "insufficient_similar_raids";
export interface CohortResult {
  dimension: RangeDimension;
  center: number;
  target: number;
  required: number;
  targetN: number;
  percent: CohortPercent;
  bounds: CohortBounds;
  n: number;
  strategy: "matched";
  quality: "sufficient" | "unavailable";
  reason: CohortUnavailableReason | null;
  averages: Record<RadarMetric, CohortMetric>;
}

export interface HistogramRange {
  /** Inclusive lower playtime bound. */
  lo: number;
  /** Exclusive upper playtime bound; null means open-ended. */
  hi: number | null;
}

/** Playtime baseline for a single achievement across the whole sample. */
export interface AchievementStat {
  /** Achievement id (matches tarkov.dev achievement ids). */
  ach_id: string;
  /** Players in the sample who own it. */
  owners: number;
  /** Mean playtime (hours) of owners — the "typical unlock hours". */
  meanHours: number;
  /** Std-dev of owner playtime; 0 when owners are near-identical or singular. */
  stdHours: number;
  /** Lower-percentile owner playtime used as the early-unlock suspicion threshold. */
  earlyHours: number;
  /** P1 for samples of at least 500 owners, otherwise P5; used only for display. */
  unlockHours: number;
}

export interface AchievementBaseline {
  /** Total players in the sample (for prevalence = owners / total). */
  total: number;
  /** One row per achievement seen in the sample. */
  achievements: AchievementStat[];
}

export interface MetricBaseline {
  /** Players in the range that actually have this metric populated (value > 0). */
  n: number;
  mean: number;
  std: number;
}

/** Mean + std of each scored metric within a playtime range (cheating-risk z-scores). */
export interface BaselineResult {
  /** Players in the range the baseline was computed over. */
  n: number;
  metrics: Record<string, MetricBaseline>;
}

export interface PlayerWriteOptions {
  leaseOwner?: string;
  leaseMaxAgeMs?: number;
}

export interface PlayerStore {
  upsert(
    aid: number,
    stats: ParsedPlayerStats,
    achievementIds: string[],
    options?: PlayerWriteOptions,
  ): Promise<void>;
  stored(aid: number): Promise<{
    stats: ParsedPlayerStats;
    achievementIds: string[];
    capturedAt: number | null;
  } | null>;
  profileSummary(aid: number): Promise<ProfileSummary | null>;
  averages(
    range: StatRange,
    statistic?: AverageStatistic,
    period?: AveragePeriod,
  ): Promise<AverageRow | null>;
  /**
   * Player count per playtime bracket. When `column` is given, also returns the
   * SUM of that column per bracket so a per-bracket average can be computed.
   */
  bracketAggregate(column: string | null, period?: AveragePeriod): Promise<BracketAgg[]>;
  /** Full distribution for the chosen range dimension. */
  bucketAggregate(
    dimension: RangeDimension,
    column: string | null,
    period?: AveragePeriod,
    statistic?: AverageStatistic,
  ): Promise<BucketAgg[]>;
  /**
   * Accounts in the period population: neither the playtime range nor the
   * metric-eligibility filter narrows it. The average dashboard reports this as
   * the scanned sample, so it must not move with the Y-axis metric.
   */
  populationCount(period?: AveragePeriod): Promise<number>;
  /** Slider bounds derived from the collected sample, with stable empty-dataset fallbacks. */
  rangeBounds(dimension: RangeDimension, period?: AveragePeriod): Promise<RangeBounds>;
  /** Adaptive comparison group around one player's playtime or PMC raid count. */
  cohort(
    dimension: RangeDimension,
    center: number,
    excludeAid: number,
    statistic?: AverageStatistic,
    period?: AveragePeriod,
  ): Promise<CohortResult>;
  /** Server-derived two-axis cohort for persistent profile comparison. */
  cohort2d(
    centerHours: number,
    centerPmcRaids: number,
    excludeAid: number,
    dimension?: "hours" | "pmc_raids",
    statistic?: AverageStatistic,
    period?: AveragePeriod,
  ): Promise<ComparisonCohortResult>;
  /**
   * Trimmed mean of one metric for each final display range. The range count is
   * derived inside each SQL statement so concurrent imports cannot skew which
   * rows are trimmed.
   */
  histogramAverages(
    column: string,
    ranges: readonly HistogramRange[],
    period?: AveragePeriod,
  ): Promise<(number | null)[]>;
  /**
   * Per-achievement playtime baseline over the whole sample: owner count plus
   * the mean/std of owner playtime, for rarity and early-unlock z-scores.
   */
  achievementBaseline(): Promise<AchievementBaseline | null>;
  /**
   * Mean + std of each scored metric over a playtime range, for the within-bracket
   * z-scores behind the cheating-risk score.
   */
  baseline(minHours: number | null, maxHours: number | null): Promise<BaselineResult>;
  riskBaseline2d(
    centerHours: number,
    centerPmcRaids: number,
    excludeAid: number,
    period?: AveragePeriod,
  ): Promise<BaselineResult>;
  riskBaseline(centerHours: number, centerPmcRaids: number, excludeAid: number): Promise<BaselineResult>;
}

export interface PlayerIndexResult {
  aid: number;
  name: string;
  /** Unix-ms profile version from the cached profile table, when available. */
  updatedAt?: number | null;
}

export interface PlayerIndexStore {
  isReady(): Promise<boolean>;
  search(nickname: string, limit: number): Promise<PlayerIndexResult[]>;
}

function parseStoredPlayer(
  row: { stats_json?: string; achievements?: string; fetched_at?: unknown } | null | undefined,
): { stats: ParsedPlayerStats; achievementIds: string[]; capturedAt: number | null } | null {
  if (!row?.stats_json) return null;
  try {
    const stats = JSON.parse(row.stats_json) as ParsedPlayerStats;
    const achievementIds = JSON.parse(row.achievements ?? "[]") as unknown;
    if (!stats || typeof stats !== "object" || typeof stats.nickname !== "string") return null;
    return {
      stats,
      achievementIds: Array.isArray(achievementIds)
        ? achievementIds.filter((id): id is string => typeof id === "string")
        : [],
      capturedAt: Number.isFinite(Number(row.fetched_at)) ? Number(row.fetched_at) : null,
    };
  } catch {
    return null;
  }
}

function parseProfileSummary(
  row: { nickname?: unknown; side?: unknown; prestige?: unknown } | null | undefined,
): ProfileSummary | null {
  if (typeof row?.nickname !== "string" || row.nickname.trim() === "") return null;
  const summary: ProfileSummary = { nickname: row.nickname };
  if (typeof row.side === "string" && row.side.trim() !== "") summary.side = row.side;
  const prestige = Number(row.prestige);
  if (row.prestige != null && Number.isFinite(prestige)) summary.prestige = prestige;
  return summary;
}

export interface DeterministicPlayerIndexCursor {
  orderKey: number;
  aid: number;
}

export interface DeterministicPlayerIndexPage {
  players: (PlayerIndexResult & { orderKey: number; trustedHours: number | null })[];
  nextCursor: DeterministicPlayerIndexCursor | null;
}


let warned = false;
function warn(msg: string) {
  if (!warned) {
    warned = true;
    console.warn("player store:", msg);
  }
}

// node:sqlite backend (self-hosted). The open is memoized as the in-flight
// promise rather than as the handle, and the promise is published synchronously
// before the first await. Caching the handle left a gap between the null check
// and the assignment three dynamic imports later: every request that arrived in
// that window passed the check, opened its own DatabaseSync and re-ran the whole
// schema initialization, and all but the last assignment became unreachable and
// stayed open for the life of the process. One promise, one open.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let opening: Promise<any | null> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getSqliteDb(): Promise<any | null> {
  if (opening) return opening;
  opening = (async () => {
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const file = process.env.SQLITE_PATH || "/data/players.db";
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Specifier cast keeps the build from type-resolving the (Node-only) module.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sqlite = (await import("node:sqlite" as string)) as any;
      // The handle is published only after the schema is in place: a failed
      // initialization must not leave a half-initialized connection behind for
      // the rest of the process, or every later call would skip the schema work
      // and fail on a missing table.
      const opened = new sqlite.DatabaseSync(file);
      try {
        initializeSqliteSchema(opened);
      } catch (error) {
        try { opened.close(); } catch { /* already closed */ }
        throw error;
      }
      return opened;
    } catch (e) {
      warn("sqlite unavailable: " + (e as Error).message);
      // A failed open must never become the cached answer. Dropping the promise
      // here is what makes the next call retry: caching it would disable the
      // player store for the life of the process over one transient failure.
      opening = null;
      return null;
    }
  })();
  return opening;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function initializeSqliteSchema(opened: any): void {
  opened.exec("PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY");
  if (!currentSqlitePlayerSchema(opened)) {
    const hasFavorites = opened.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'favorites'"
    ).get();
    if (hasFavorites) initializeFavoritesSchema(opened);
    opened.exec(SCHEMA);
    initializeFavoritesSchema(opened);
    // Lightweight migration for DBs created before the PMC score columns existed.
    // CREATE TABLE IF NOT EXISTS won't add columns to an existing table, so add
    // them here; a duplicate-column error on already-migrated DBs is expected.
    for (const [table, col, type] of [
      ["players", "pmc_survival_rate", "REAL DEFAULT 0"],
      ["players", "pmc_kills_per_raid", "REAL DEFAULT 0"],
      ["players", "profile_updated_at", "INTEGER DEFAULT 0"],
      ["players", "pvp_stats_known", "INTEGER DEFAULT 0"],
      ["players", "pvp_stats_version", "INTEGER DEFAULT 0"],
      ["players", "pmc_killed_pmc", "INTEGER"],
      ["players", "last_played_at", "INTEGER"],
      ["mode_players", "profile_updated_at", "INTEGER DEFAULT 0"],
      ["mode_players", "pvp_stats_known", "INTEGER DEFAULT 0"],
      ["mode_players", "pvp_stats_version", "INTEGER DEFAULT 0"],
      ["mode_players", "pmc_killed_pmc", "INTEGER"],
      ["mode_players", "last_played_at", "INTEGER"],
    ]) {
      try {
        opened.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
      } catch {
        /* column already exists */
      }
    }
    opened.exec(
      "CREATE INDEX IF NOT EXISTS idx_players_profile_updated_at ON players(profile_updated_at)"
    );
    opened.exec(
      "CREATE INDEX IF NOT EXISTS idx_players_cohort_regular ON players(pvp_stats_known, profile_updated_at, hours, pmc_raids)"
    );
    opened.exec(`UPDATE players SET pvp_stats_known = 1
      WHERE pvp_stats_known = 0 AND (killed_pmc > 0 OR pmc_kd_ratio > 0)`);
    opened.exec(`UPDATE mode_players SET pvp_stats_known = 1
      WHERE pvp_stats_known = 0 AND (killed_pmc > 0 OR pmc_kd_ratio > 0)`);
  }
  initializeProfileChangeJournal(opened);
  ensureSqliteCohortIndexes(opened);
  ensureSqliteAverageIndexes(opened);
  initializeArenaSchema(opened);
}


/** Arena analytics shares the local SQLite database with the profile store. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getArenaBackend(): Promise<{ db: any } | null> {
  const sqlite = await getSqliteDb();
  return sqlite ? { db: sqlite } : null;
}

async function sqliteStore(mode: CrossSectionMode): Promise<PlayerStore | null> {
  const rawDb = await getSqliteDb();
  if (!rawDb) return null;
  try {
    const table = tableFor(mode);
    const hasPlayerIndex = mode === "regular" && Boolean(rawDb.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'player_index'"
    ).get());
    const q = (sql: string) => scopePlayerSql(sql, table);
    const db = { prepare: (sql: string) => rawDb.prepare(q(sql)) };
    return {
      async upsert(aid, stats, ids, options = {}) {
        const now = Date.now();
        if (MAX_PLAYERS > 0) {
          const existing = db.prepare("SELECT 1 FROM players WHERE aid = ?").get(aid);
          if (!existing) {
            const row = db.prepare("SELECT COUNT(*) AS n FROM players").get() as { n: number };
            if (row && row.n >= MAX_PLAYERS) return;
          }
        }
        if (mode === "regular") {
          rawDb.exec("BEGIN IMMEDIATE");
          try {
            const profileUpdatedAt = Number(stats.profileUpdatedAt) || 0;
            db.prepare(SQLITE_UPSERT_SQL).run(...argsFor(aid, stats, ids, now), aid);
            if (hasPlayerIndex) {
              rawDb.prepare(`INSERT INTO player_index
                (aid, nickname, nickname_lower, synced_at)
                SELECT ?, ?, ?, ? WHERE EXISTS (
                  SELECT 1 FROM players WHERE aid = ? AND profile_updated_at = ?
                ) AND NOT EXISTS (SELECT 1 FROM excluded_players WHERE aid = ?)
                ON CONFLICT(aid) DO UPDATE SET nickname = excluded.nickname,
                  nickname_lower = excluded.nickname_lower, synced_at = excluded.synced_at`)
                .run(aid, stats.nickname, normalizeNickname(stats.nickname), now,
                  aid, profileUpdatedAt, aid);
            }
            rawDb.exec("COMMIT");
          } catch (error) {
            rawDb.exec("ROLLBACK");
            throw error;
          }
        } else {
          if (mode === "arena" && stats.arenaProfile) {
            rawDb.exec("BEGIN IMMEDIATE");
            try {
              if (options.leaseOwner) {
                const lease = rawDb.prepare(
                  "SELECT owner, heartbeat_at FROM arena_profile_sync_lease WHERE id = 1"
                ).get() as { owner?: unknown; heartbeat_at?: unknown } | undefined;
                const leaseNow = Date.now();
                const age = leaseNow - Number(lease?.heartbeat_at);
                const maxAge = options.leaseMaxAgeMs ?? 30 * 60_000;
                if (lease?.owner !== options.leaseOwner || !Number.isFinite(age) || age < 0 || age > maxAge) {
                  throw new Error("Arena profile sync lease was lost");
                }
              }
              rawDb.prepare(SQLITE_MODE_UPSERT_SQL)
                .run(mode, ...argsFor(aid, stats, ids, now), JSON.stringify(stats), aid);
              upsertArenaSqlite(rawDb, stats.arenaProfile, now);
              rawDb.exec("COMMIT");
            } catch (error) {
              rawDb.exec("ROLLBACK");
              throw error;
            }
          } else {
            rawDb.prepare(SQLITE_MODE_UPSERT_SQL)
              .run(mode, ...argsFor(aid, stats, ids, now), JSON.stringify(stats), aid);
          }
        }
      },
      async stored(aid) {
        if (mode === "regular") return null;
        const row = db.prepare(
          "SELECT stats_json, achievements, fetched_at FROM players WHERE aid = ?"
        ).get(aid) as { stats_json?: string; achievements?: string; fetched_at?: unknown } | undefined;
        return parseStoredPlayer(row);
      },
      async profileSummary(aid) {
        const row = db.prepare(
          "SELECT nickname, side, prestige FROM players WHERE aid = ?"
        ).get(aid) as { nickname?: unknown; side?: unknown; prestige?: unknown } | undefined;
        return parseProfileSummary(row);
      },
      async averages(range, statistic = "trimmed_mean", period = "all") {
        const { where: rangeWhere, params } = statRangeClause(range);
        const where = averagePeriodWhere(mode, period, rangeWhere);
        const cnt = db.prepare(countSql(where)).get(...params) as { n: number } | undefined;
        const n = Number(cnt?.n ?? 0);
        if (n === 0) return emptyAverageRow();
        const row: AverageRow = { n, metricCounts: {} };
        for (const c of AVG_COLS) {
          const metricWhere = eligibleMetricWhere(mode, c, where);
          const count = metricWhere === where
            ? n
            : Number((db.prepare(countSql(metricWhere)).get(...params) as { n: number } | undefined)?.n ?? 0);
          const { trim, off, lim } = trimWindow(count);
          const stmt = db.prepare(metricStatisticSql(c, metricWhere, statistic, trim));
          const r = (statistic === "trimmed_mean" && trim
            ? stmt.get(...params, lim, off)
            : stmt.get(...params)) as
            | { a: number | null }
            | undefined;
          row[c] = r?.a == null ? null : Number(r.a);
          row.metricCounts[c] = count;
        }
        return row;
      },
      async bracketAggregate(column, period = "all") {
        const where = eligibleMetricWhere(mode, column ?? "", averagePeriodWhere(mode, period, ""));
        const rows = db.prepare(aggSql(column, where)).all() as { bracket_key: string; n: number; s: number }[];
        return toBracketAggs(rows);
      },
      async bucketAggregate(dimension, column, period = "all", statistic = "trimmed_mean") {
        const where = eligibleMetricWhere(mode, column ?? "", averagePeriodWhere(mode, period, ""));
        const rows = db.prepare(bucketAggSql(dimension, column, where, statistic)).all() as {
          lo: number; hi: number | null; n: number; s: number;
        }[];
        return toBucketAggs(rows);
      },
      async populationCount(period = "all") {
        const where = averagePeriodWhere(mode, period, "");
        const row = db.prepare(countSql(where)).get() as { n?: unknown } | undefined;
        return Number(row?.n ?? 0) || 0;
      },
      async rangeBounds(dimension, period = "all") {
        const column = rangeColumn(dimension);
        const where = averagePeriodWhere(mode, period, "");
        const row = db.prepare(
          `SELECT MIN(${column}) AS lo, MAX(${column}) AS hi FROM players ${where}`
        ).get() as { lo: number | null; hi: number | null } | undefined;
        if (row?.lo == null || row.hi == null) {
          return { min: 0, max: dimension === "hours" ? 5000 : 1000 };
        }
        return { min: Math.max(0, Math.floor(Number(row.lo))), max: Math.ceil(Number(row.hi)) };
      },
      async cohort(dimension, center, excludeAid, statistic = "trimmed_mean", period = "all") {
        if (center <= 0) {
          return unavailableCohort(
            dimension, center, 10, { min: 0, max: 0 }, 0, "no_activity"
          );
        }
        const cutoff = mode === "regular"
          ? Math.floor(Date.now() - 90 * 86_400_000)
          : undefined;
        const ranges = uniqueCohortRanges(dimension, center);
        const countParams = ranges.flatMap(({ bounds }) => [bounds.min, bounds.max]);
        const countWhere = cohortEligibilityWhere(mode, averagePeriodWhere(
          mode,
          cohortSelectionPeriod(mode, period),
          `WHERE ${rangeColumn(dimension)} > 0 AND aid != ?`,
          cutoff,
        ));
        const countRow = db.prepare(cohortCountSql(dimension, ranges, countWhere))
          .get(...countParams, excludeAid) as Record<string, number | null> | undefined;
        const countFor = (bounds: CohortBounds) => {
          const match = ranges.find((entry) =>
            entry.bounds.min === bounds.min && entry.bounds.max === bounds.max
          );
          return Number(match ? countRow?.[`n${match.percent}`] ?? 0 : 0);
        };
        const selected = COHORT_PERCENTAGES.map((percent) => ({
          percent,
          bounds: cohortBounds(dimension, center, percent),
        })).find(({ bounds }) => countFor(bounds) >= COHORT_TARGET);
        if (!selected) {
          const percent = 30;
          const bounds = cohortBounds(dimension, center, percent);
          const n = countFor(bounds);
          const maxValue = Number(countRow?.max_value ?? 0);
          const reason: CohortUnavailableReason = maxValue < bounds.min
            ? "above_coverage"
            : dimension === "hours"
              ? "insufficient_similar_hours"
              : "insufficient_similar_raids";
          return unavailableCohort(dimension, center, percent, bounds, n, reason);
        }
        const groupRange: StatRange = {
          dimension,
          min: selected.bounds.min,
          max: selected.bounds.max,
          maxInclusive: true,
          excludeAid,
          requirePositive: true,
        };
        const { where: groupWhere, params } = statRangeClause(groupRange);
        const where = cohortEligibilityWhere(
          mode,
          averagePeriodWhere(mode, period, groupWhere, cutoff),
        );
        const cohortN = Number(
          (db.prepare(countSql(where)).get(...params) as { n: number } | undefined)?.n ?? 0
        );
        if (cohortN < COHORT_TARGET) {
          const reason: CohortUnavailableReason = dimension === "hours"
            ? "insufficient_similar_hours"
            : "insufficient_similar_raids";
          return unavailableCohort(
            dimension, center, selected.percent, selected.bounds, cohortN, reason
          );
        }
        const averages = emptyCohortMetrics();
        for (const metric of RADAR_COLS) {
          const metricWhere = populatedMetricClause(mode, metric, where);
          const count = metricWhere !== where
            ? Number((db.prepare(countSql(metricWhere)).get(...params) as { n: number } | undefined)?.n ?? 0)
            : cohortN;
          // The cohort itself is already guaranteed to contain at least 20 players.
          // PMC survival is a backfilled field, so average the confirmed values that
          // exist instead of hiding the axis until 20 profiles have been refreshed.
          const minimumPopulatedCount = metric === "pmc_survival_rate" ? 1 : COHORT_TARGET;
          if (count < minimumPopulatedCount) {
            averages[metric] = { value: null, count };
            continue;
          }
          const { trim, off, lim } = trimWindow(count);
          const stmt = db.prepare(metricStatisticSql(metric, metricWhere, statistic, trim));
          const row = (statistic === "trimmed_mean" && trim
            ? stmt.get(...params, lim, off)
            : stmt.get(...params)) as
            | { a: number | null }
            | undefined;
          averages[metric] = { value: row?.a == null ? null : Number(row.a), count };
        }
        return {
          dimension,
          center,
          target: COHORT_TARGET,
          required: COHORT_TARGET,
          targetN: COHORT_TARGET,
          percent: selected.percent,
          bounds: selected.bounds,
          n: cohortN,
          strategy: "matched",
          quality: "sufficient",
          reason: null,
          averages,
        };
      },
      async cohort2d(
        centerHours,
        centerPmcRaids,
        excludeAid,
        dimension = "hours",
        statistic = "trimmed_mean",
        period = "all",
      ) {
        if (mode === "arena") throw new Error("arena comparison cohort is unavailable");
        return computePersistentTwoDimensionalCohort({
          mode,
          center: { hours: centerHours, pmcRaids: centerPmcRaids },
          excludeAid,
          dimension,
          statistic,
          period,
          readFirst: async (sql, params) => db.prepare(sql).get(...params) as Record<string, unknown> | null,
          readAll: async (sql, params) => db.prepare(sql).all(...params) as Record<string, unknown>[],
        });
      },
      async histogramAverages(column, ranges, period = "all") {
        return ranges.map((range) => {
          const { where: rangeWhere, params } = legacyHoursRangeClause(range.lo, range.hi);
          const where = eligibleMetricWhere(
            mode,
            column,
            averagePeriodWhere(mode, period, rangeWhere),
          );
          const row = db.prepare(histogramAvgSql(column, where)).get(...params) as
            | { a: number | null }
            | undefined;
          return row?.a == null ? null : Number(row.a);
        });
      },
      async achievementBaseline() {
        return mode === "arena" ? null : readPublishedAchievementBaseline(rawDb, mode);
      },
      async baseline(min, max) {
        const { where, params } = legacyHoursRangeClause(min, max);
        const row = db.prepare(baselineSql(where)).get(...params) as Record<string, number> | undefined;
        return toBaseline(row);
      },
      async riskBaseline2d(centerHours, centerPmcRaids, excludeAid, period = "all") {
        if (mode === "arena") throw new Error("arena risk baseline is unavailable");
        return computePersistentRiskBaseline({
          mode,
          center: { hours: centerHours, pmcRaids: centerPmcRaids },
          excludeAid,
          period,
          readFirst: async (sql, params) => db.prepare(sql).get(...params) as Record<string, unknown> | null,
        });
      },
      async riskBaseline(centerHours, centerPmcRaids, excludeAid) {
        if (mode === "arena") throw new Error("arena risk baseline is unavailable");
        return computePersistentRiskBaseline({
          mode,
          center: { hours: centerHours, pmcRaids: centerPmcRaids },
          excludeAid,
          period: "all",
          readFirst: async (sql, params) => db.prepare(sql).get(...params) as Record<string, unknown> | null,
        });
      },
    };
  } catch (e) {
    warn("sqlite unavailable: " + (e as Error).message);
    return null;
  }
}

/** Returns the local SQLite store, or null when unavailable. */
export async function getStore(mode: CrossSectionMode = "regular"): Promise<PlayerStore | null> {
  return sqliteStore(mode);
}

function normalizeNickname(s: string): string {
  return s.trim().toLowerCase();
}

function toIndexResults(rows: { aid: number; name: string; updated_at?: unknown }[]): PlayerIndexResult[] {
  return rows.map((row) => {
    const updatedAt = row.updated_at == null ? null : Number(row.updated_at);
    return {
      aid: Number(row.aid),
      name: String(row.name),
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : null,
    };
  });
}

function pushUniqueIndexResults(
  out: PlayerIndexResult[],
  seen: Set<number>,
  rows: PlayerIndexResult[],
  limit: number
) {
  for (const row of rows) {
    // Check before appending: the second call starts with `out` already full, and
    // a trailing check would let it through one row past the limit.
    if (out.length >= limit) break;
    if (seen.has(row.aid)) continue;
    seen.add(row.aid);
    out.push(row);
  }
}

export type PersistentPlayerIndexMode = "regular" | "pve" | "arena";

const PLAYER_INDEX_SPECS: Record<PersistentPlayerIndexMode, {
  table: string;
  meta: string;
  modeWhere: string;
}> = {
  regular: { table: "player_index", meta: "player_index_meta", modeWhere: "" },
  pve: { table: "pve_player_index", meta: "pve_player_index_meta", modeWhere: "i.mode = 'pve' AND " },
  arena: { table: "arena_player_index", meta: "arena_player_index_meta", modeWhere: "i.mode = 'arena' AND " },
};

function playerIndexSql(mode: PersistentPlayerIndexMode, includeProfileMetadata: boolean) {
  const { table, meta, modeWhere } = PLAYER_INDEX_SPECS[mode];
  const profileTable = mode === "regular" ? "players" : "mode_players";
  const profileMode = mode === "regular" ? "" : ` AND p.mode = '${mode}'`;
  const profileSelect = includeProfileMetadata ? "p.profile_updated_at" : "NULL";
  const profileJoin = includeProfileMetadata
    ? ` LEFT JOIN ${profileTable} AS p ON p.aid = i.aid${profileMode}`
    : "";
  return {
    ready: `SELECT value FROM ${meta} WHERE key = 'synced_at'`,
    exact: `SELECT i.aid, i.nickname AS name, ${profileSelect} AS updated_at FROM ${table} AS i${profileJoin} ` +
      `WHERE ${modeWhere}i.nickname_lower = ? ` +
      "AND NOT EXISTS (SELECT 1 FROM excluded_players tombstone WHERE tombstone.aid = i.aid) " +
      "ORDER BY i.aid LIMIT ?",
    prefix: `SELECT i.aid, i.nickname AS name, ${profileSelect} AS updated_at FROM ${table} AS i${profileJoin} ` +
      `WHERE ${modeWhere}i.nickname_lower >= ? AND i.nickname_lower < ? ` +
      "AND NOT EXISTS (SELECT 1 FROM excluded_players tombstone WHERE tombstone.aid = i.aid) " +
      "ORDER BY i.nickname_lower, i.aid LIMIT ?",
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sqliteProfileMetadataAvailable(db: any, mode: PersistentPlayerIndexMode): boolean {
  const table = mode === "regular" ? "players" : "mode_players";
  const modeColumn = mode === "regular" ? "" : ", mode";
  try {
    db.prepare(`SELECT profile_updated_at${modeColumn} FROM ${table} LIMIT 1`).get();
    return true;
  } catch {
    return false;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sqlitePlayerIndexStore(db: any, mode: PersistentPlayerIndexMode, includeProfileMetadata: boolean): PlayerIndexStore {
  const sql = playerIndexSql(mode, includeProfileMetadata);
  return {
    async isReady() {
      return Boolean(db.prepare(sql.ready).get());
    },
    async search(nickname, limit) {
      const q = normalizeNickname(nickname);
      const exact = toIndexResults(
        db.prepare(sql.exact).all(q, limit) as { aid: number; name: string; updated_at?: unknown }[]
      );
      const prefix = toIndexResults(
        db.prepare(sql.prefix).all(q, `${q}\uffff`, limit * 2) as {
          aid: number;
          name: string;
          updated_at?: unknown;
        }[]
      );
      const out: PlayerIndexResult[] = [];
      const seen = new Set<number>();
      pushUniqueIndexResults(out, seen, exact, limit);
      pushUniqueIndexResults(out, seen, prefix, limit);
      return out;
    },
  };
}

/** Returns the synced public nickname index, or null if no DB backend exists. */
export async function getPlayerIndexStore(
  mode: PersistentPlayerIndexMode = "regular",
): Promise<PlayerIndexStore | null> {
  const sqlite = await getSqliteDb();
  if (sqlite) return sqlitePlayerIndexStore(sqlite, mode, sqliteProfileMetadataAvailable(sqlite, mode));
  return null;
}

/** Read-only handle on the index metadata table, for the coverage counters the
 *  home page serves. Separate from the index store because that one prepares
 *  search statements against the full table; this only needs `player_index_meta`
 *  and must stay usable when the index itself is empty or absent. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getPublicIndexMetaReader(): Promise<any | null> {
  return getSqliteDb();
}

/**
 * Stable pseudo-random traversal for the nickname-only public index. The index
 * has no activity metadata, so callers validate each returned aid separately.
 * Cached `players.hours` is trusted because it was parsed server-side from the
 * public PvP profile and is never accepted from a browser request.
 */
export async function getDeterministicPlayerIndexPage(
  cycleId: string,
  cursor: DeterministicPlayerIndexCursor | null,
  limit: number,
): Promise<DeterministicPlayerIndexPage | null> {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(cycleId)) throw new Error("invalid cycleId");
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("invalid index page limit");
  const { multiplier, offset } = seasonalCandidateOrderParameters(cycleId);
  const cursorKey = cursor?.orderKey ?? -1;
  const cursorAid = cursor?.aid ?? 0;
  const sql = `WITH ordered AS (
    SELECT i.aid, i.nickname AS name,
      ((i.aid * ? + ?) & 2147483647) AS order_key,
      CASE WHEN p.hours IS NOT NULL AND p.hours >= 0 THEN p.hours ELSE NULL END AS trusted_hours
    FROM player_index i LEFT JOIN players p ON p.aid = i.aid
    WHERE NOT EXISTS (SELECT 1 FROM excluded_players tombstone WHERE tombstone.aid = i.aid)
  ) SELECT aid, name, order_key, trusted_hours FROM ordered
    WHERE order_key > ? OR (order_key = ? AND aid > ?)
    ORDER BY order_key, aid LIMIT ?`;
  const sqlite = await getSqliteDb();
  if (!sqlite) return null;
  const rows = sqlite.prepare(sql).all(multiplier, offset, cursorKey, cursorKey, cursorAid, limit) as Record<string, unknown>[];
  const players = rows.map((row) => ({
    aid: Number(row.aid),
    name: String(row.name),
    updatedAt: null,
    orderKey: Number(row.order_key),
    trustedHours: row.trusted_hours == null ? null : Number(row.trusted_hours),
  }));
  const last = players.at(-1);
  return {
    players,
    nextCursor: last && players.length === limit ? { orderKey: last.orderKey, aid: last.aid } : null,
  };
}

/** One trusted, already-parsed PvP playtime value; no upstream request. */
export async function getTrustedPublicHours(aid: number): Promise<number | null> {
  if (!Number.isSafeInteger(aid) || aid <= 0) return null;
  const row = (await getSqliteDb())?.prepare(`SELECT hours FROM players WHERE aid = ? AND hours >= 0
        AND NOT EXISTS (SELECT 1 FROM excluded_players tombstone WHERE tombstone.aid = players.aid)`).get(aid);
  if (!row || !Number.isFinite(Number((row as { hours?: unknown }).hours))) return null;
  return Number((row as { hours: unknown }).hours);
}

// ── Favorites: game accounts a signed-in user has pinned ──────────────────────

/** One pinned game account, as stored for a user. */
export interface Favorite {
  mode: ProfileIdentity["mode"];
  cycleId: string;
  aid: number;
  /** Snapshot of the nickname (refreshed whenever stats are pulled); may be null. */
  nickname: string | null;
  /** Free-text user note / label, or null. */
  note: string | null;
  /** Whether this is the user's own ("main") account. At most one per user. */
  isMain: boolean;
  /** Unix ms when it was pinned. */
  createdAt: number;
}

export interface FavoritesStore {
  /** A user's favorites, main first, then newest first. */
  list(userSub: string, identity?: FavoriteIdentity | null): Promise<Favorite[]>;
  /** Pin an account globally by AID. "exists" if already pinned in any identity. */
  add(
    userSub: string,
    aid: number,
    nickname: string | null,
    note: string | null,
    identity?: FavoriteIdentity
  ): Promise<"ok" | "exists" | "limit">;
  /** Unpin every stored identity for this AID. */
  remove(userSub: string, aid: number, identity?: FavoriteIdentity): Promise<void>;
  /**
   * Set/clear the note. False when the AID is not one of the user's favorites:
   * the update is scoped to `user_sub`, so a zero row count means the write was
   * skipped and the caller has to be able to tell a refused mutation from an
   * applied one. Rewriting the same note still reports a match.
   */
  setNote(userSub: string, aid: number, note: string | null, identity?: FavoriteIdentity): Promise<boolean>;
  /**
   * Mark one favorite as the user's main account (clears the flag on the rest).
   * False when the AID is not one of the user's favorites: the statement's
   * ownership guard then matches nothing and no row is written, so the caller
   * has to be able to tell a refused mutation from an applied one.
   */
  setMain(userSub: string, aid: number, identity?: FavoriteIdentity): Promise<boolean>;
  /** Refresh the stored nickname snapshot. */
  updateNickname(userSub: string, aid: number, nickname: string | null, identity?: FavoriteIdentity): Promise<void>;
}

export type FavoriteIdentity = Pick<ProfileIdentity, "mode" | "cycleId">;

function favoriteIdentity(identity?: FavoriteIdentity): FavoriteIdentity {
  return identity ?? LEGACY_IDENTITY;
}

const FAV_LIST_SQL =
  "SELECT rowid AS source_rowid, mode, cycle_id, aid, nickname, note, is_main, created_at FROM favorites " +
  "WHERE user_sub = ? AND mode = ? AND cycle_id = ? ORDER BY is_main DESC, created_at DESC";
const FAV_LIST_ALL_SQL =
  "SELECT rowid AS source_rowid, mode, cycle_id, aid, nickname, note, is_main, created_at FROM favorites " +
  "WHERE user_sub = ? ORDER BY is_main DESC, created_at DESC";
interface FavRow {
  source_rowid: number;
  mode: ProfileIdentity["mode"];
  cycle_id: string;
  aid: number;
  nickname: string | null;
  note: string | null;
  is_main: number;
  created_at: number;
}

function toFavorites(rows: FavRow[]): Favorite[] {
  const mapped = rows.map((r) => ({
    mode: r.mode,
    cycleId: r.cycle_id,
    aid: Number(r.aid),
    nickname: r.nickname ?? null,
    note: r.note ?? null,
    isMain: Number(r.is_main) === 1,
    createdAt: Number(r.created_at),
    sourceRowId: Number(r.source_rowid),
  } satisfies Favorite & { sourceRowId: number }));
  const groups = Map.groupBy(mapped, (favorite) => favorite.aid);
  const favorites = [...groups.values()].map((group) => {
    const newest = [...group].sort((a, b) => b.createdAt - a.createdAt || b.sourceRowId - a.sourceRowId);
    const canonical = [...group].sort((a, b) =>
      Number(b.mode === "regular") - Number(a.mode === "regular")
      || b.createdAt - a.createdAt
      || b.sourceRowId - a.sourceRowId
    )[0];
    const { sourceRowId: _sourceRowId, ...favorite } = canonical;
    void _sourceRowId;
    return {
      ...favorite,
      nickname: newest.find((favorite) => favorite.nickname)?.nickname ?? null,
      note: newest.find((favorite) => favorite.note)?.note ?? null,
      isMain: group.some((favorite) => favorite.isMain),
      createdAt: Math.min(...group.map((favorite) => favorite.createdAt)),
    };
  }).sort((a, b) => Number(b.isMain) - Number(a.isMain) || b.createdAt - a.createdAt || a.aid - b.aid);
  const mainAid = favorites.find((favorite) => favorite.isMain)?.aid ?? null;
  return favorites.map((favorite) => ({ ...favorite, isMain: favorite.aid === mainAid }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sqliteFavoritesStore(db: any): FavoritesStore {
  return {
    async list(userSub, identity) {
      if (identity === null) {
        return toFavorites(db.prepare(FAV_LIST_ALL_SQL).all(userSub) as FavRow[]);
      }
      const id = favoriteIdentity(identity);
      return toFavorites(db.prepare(FAV_LIST_SQL).all(userSub, id.mode, id.cycleId) as FavRow[]);
    },
    async add(userSub, aid, nickname, note, identity) {
      const id = favoriteIdentity(identity);
      const inserted = db.prepare(FAVORITE_INSERT_SQL)
        .run(userSub, id.mode, id.cycleId, aid, nickname, note, Date.now(), userSub, aid, userSub, MAX_FAVORITES);
      if (inserted.changes === 1) return "ok";
      const existing = db.prepare("SELECT 1 FROM favorites WHERE user_sub = ? AND aid = ?").get(userSub, aid);
      const row = db.prepare("SELECT COUNT(DISTINCT aid) AS n FROM favorites WHERE user_sub = ?")
        .get(userSub) as { n: number };
      return favoriteInsertResult(inserted.changes, Boolean(existing), Number(row?.n ?? 0));
    },
    async remove(userSub, aid) {
      db.prepare("DELETE FROM favorites WHERE user_sub = ? AND aid = ?").run(userSub, aid);
    },
    async setNote(userSub, aid, note) {
      // SQLite counts an UPDATE by the rows it matched, not by the values it
      // changed, so an owned aid always reports at least one even when the note
      // is rewritten to the text it already had.
      return db.prepare("UPDATE favorites SET note = ? WHERE user_sub = ? AND aid = ?").run(note, userSub, aid).changes > 0;
    },
    async setMain(userSub, aid) {
      // The EXISTS guard makes a zero row count mean "not the caller's favorite",
      // not "already in that state" — the statement rewrites every one of the
      // user's rows either way, so a matching aid always reports at least one.
      return db.prepare(FAVORITE_SET_MAIN_SQL).run(aid, userSub, userSub, aid).changes > 0;
    },
    async updateNickname(userSub, aid, nickname) {
      db.prepare("UPDATE favorites SET nickname = ? WHERE user_sub = ? AND aid = ?").run(nickname, userSub, aid);
    },
  };
}

/** Returns the local favorites store, or null when SQLite is unavailable. */
export async function getFavoritesStore(): Promise<FavoritesStore | null> {
  const sq = await getSqliteDb();
  if (sq) return sqliteFavoritesStore(sq);
  return null;
}
