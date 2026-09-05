import {
  ARENA_MODE_KEYS,
  ARENA_RAW_COUNTERS,
  type ArenaCounters,
  type ArenaModeKey,
  type ArenaProfile,
  type ArenaProfileRisk,
  type ArenaStoredMode,
}
// @ts-expect-error Node's direct TypeScript runner needs the explicit extension.
from "../../types/arena.ts";

export const ARENA_PARSER_VERSION = 2;

export const ARENA_STORAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS arena_mode_stats (
  aid INTEGER NOT NULL,
  arena_mode TEXT NOT NULL CHECK (arena_mode IN ('overall', 'teamFight', 'lastHero', 'checkpoint', 'blastGang', 'shootOutDuo')),
  hours REAL,
  games_count INTEGER,
  arena_wins INTEGER,
  arena_losses INTEGER,
  kills INTEGER,
  deaths INTEGER,
  assists INTEGER,
  headshots INTEGER,
  damage_dealt REAL,
  round_mvp_count INTEGER,
  match_mvp_count INTEGER,
  current_kill_streak INTEGER,
  max_kill_streak INTEGER,
  current_win_streak INTEGER,
  max_win_streak INTEGER,
  current_loss_streak INTEGER,
  max_loss_streak INTEGER,
  kd_ratio REAL,
  win_rate REAL,
  headshot_rate REAL,
  kills_per_match REAL,
  damage_per_match REAL,
  best_arp REAL,
  upstream_version INTEGER NOT NULL,
  parser_version INTEGER NOT NULL,
  raw_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (aid, arena_mode)
);
CREATE INDEX IF NOT EXISTS idx_arena_mode_stats_mode_hours
  ON arena_mode_stats(arena_mode, hours, games_count);
CREATE INDEX IF NOT EXISTS idx_arena_mode_stats_aid_version
  ON arena_mode_stats(aid, upstream_version);
CREATE INDEX IF NOT EXISTS idx_arena_mode_stats_best_arp
  ON arena_mode_stats(arena_mode, best_arp DESC);

CREATE TABLE IF NOT EXISTS arena_mode_stats_history (
  aid INTEGER NOT NULL,
  arena_mode TEXT NOT NULL CHECK (arena_mode IN ('overall', 'teamFight', 'lastHero', 'checkpoint', 'blastGang', 'shootOutDuo')),
  hours REAL,
  games_count INTEGER,
  arena_wins INTEGER,
  arena_losses INTEGER,
  kills INTEGER,
  deaths INTEGER,
  assists INTEGER,
  headshots INTEGER,
  damage_dealt REAL,
  round_mvp_count INTEGER,
  match_mvp_count INTEGER,
  current_kill_streak INTEGER,
  max_kill_streak INTEGER,
  current_win_streak INTEGER,
  max_win_streak INTEGER,
  current_loss_streak INTEGER,
  max_loss_streak INTEGER,
  kd_ratio REAL,
  win_rate REAL,
  headshot_rate REAL,
  kills_per_match REAL,
  damage_per_match REAL,
  best_arp REAL,
  upstream_version INTEGER NOT NULL,
  parser_version INTEGER NOT NULL,
  raw_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (aid, arena_mode, upstream_version, parser_version)
);
CREATE INDEX IF NOT EXISTS idx_arena_mode_stats_history_aid_version
  ON arena_mode_stats_history(aid, upstream_version);
CREATE INDEX IF NOT EXISTS idx_arena_mode_stats_history_mode_version
  ON arena_mode_stats_history(arena_mode, upstream_version);

CREATE TABLE IF NOT EXISTS arena_risk_evaluations (
  aid INTEGER PRIMARY KEY,
  upstream_version INTEGER NOT NULL,
  parser_version INTEGER NOT NULL,
  evaluated_at INTEGER NOT NULL,
  risk_json TEXT NOT NULL
);
`;

const COUNTER_COLUMNS: Record<keyof ArenaCounters, string> = {
  matches: "games_count",
  wins: "arena_wins",
  losses: "arena_losses",
  kills: "kills",
  deaths: "deaths",
  assists: "assists",
  headshots: "headshots",
  damage: "damage_dealt",
  round_mvp: "round_mvp_count",
  match_mvp: "match_mvp_count",
  current_kill_streak: "current_kill_streak",
  max_kill_streak: "max_kill_streak",
  current_win_streak: "current_win_streak",
  max_win_streak: "max_win_streak",
  current_loss_streak: "current_loss_streak",
  max_loss_streak: "max_loss_streak",
};

const ARENA_COLUMNS = [
  "aid", "arena_mode", "hours", ...Object.values(COUNTER_COLUMNS),
  "kd_ratio", "win_rate", "headshot_rate", "kills_per_match", "damage_per_match",
  "best_arp",
  "upstream_version", "parser_version", "raw_json", "fetched_at",
] as const;

export const ARENA_UPSERT_SQL = `INSERT INTO arena_mode_stats (${ARENA_COLUMNS.join(", ")})
  SELECT ${ARENA_COLUMNS.map(() => "?").join(", ")}
  WHERE NOT EXISTS (SELECT 1 FROM excluded_players WHERE aid = ?)
  ON CONFLICT(aid, arena_mode) DO UPDATE SET
    ${ARENA_COLUMNS.filter((column) => column !== "aid" && column !== "arena_mode")
      .map((column) => `${column} = excluded.${column}`).join(", ")}
  WHERE excluded.upstream_version > arena_mode_stats.upstream_version
    OR (excluded.upstream_version = arena_mode_stats.upstream_version
      AND excluded.parser_version >= arena_mode_stats.parser_version)`;

export const ARENA_HISTORY_INSERT_SQL = `INSERT OR IGNORE INTO arena_mode_stats_history (${ARENA_COLUMNS.join(", ")})
  SELECT ${ARENA_COLUMNS.map(() => "?").join(", ")}
  WHERE NOT EXISTS (SELECT 1 FROM excluded_players WHERE aid = ?)`;

export const ARENA_HISTORY_BACKFILL_SQL = `INSERT OR IGNORE INTO arena_mode_stats_history
  SELECT current.* FROM arena_mode_stats current`;

export const ARENA_RISK_UPSERT_SQL = `INSERT INTO arena_risk_evaluations
  (aid, upstream_version, parser_version, evaluated_at, risk_json)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(aid) DO UPDATE SET
    upstream_version = excluded.upstream_version,
    parser_version = excluded.parser_version,
    evaluated_at = excluded.evaluated_at,
    risk_json = excluded.risk_json
  WHERE excluded.upstream_version > arena_risk_evaluations.upstream_version
    OR (excluded.upstream_version = arena_risk_evaluations.upstream_version
      AND excluded.parser_version > arena_risk_evaluations.parser_version)
    OR (excluded.upstream_version = arena_risk_evaluations.upstream_version
      AND excluded.parser_version = arena_risk_evaluations.parser_version
      AND excluded.evaluated_at >= arena_risk_evaluations.evaluated_at)`;

type ArenaStoredSnapshot = {
  mode: ArenaStoredMode;
  hours: number | null;
  counters: ArenaCounters;
  metrics: ArenaProfile["overall"]["metrics"];
  bestArp: number | null;
  source?: ArenaProfile["overall"]["source"];
};

function storedSnapshots(profile: ArenaProfile): ArenaStoredSnapshot[] {
  return [
    {
      mode: "overall",
      hours: profile.overall.hours,
      counters: profile.overall.counters,
      metrics: profile.overall.metrics,
      bestArp: profile.overall.bestArp,
      source: profile.overall.source,
    },
    ...ARENA_MODE_KEYS.map((mode) => ({
      mode,
      // The upstream has no per-mode time. Duplicate the trusted global value
      // for matching peers by hours without pretending it belongs to this mode.
      hours: profile.overall.hours,
      counters: profile.modes[mode].counters,
      metrics: profile.modes[mode].metrics,
      bestArp: null,
    })),
  ];
}

function valuesFor(profile: ArenaProfile, snapshot: ArenaStoredSnapshot, now: number): unknown[] {
  const sourceCounters = profile[ARENA_RAW_COUNTERS]?.[snapshot.mode] ?? null;
  return [
    profile.aid,
    snapshot.mode,
    snapshot.hours,
    ...Object.keys(COUNTER_COLUMNS).map((key) => snapshot.counters[key as keyof ArenaCounters]),
    snapshot.metrics.kd_ratio,
    snapshot.metrics.win_rate,
    snapshot.metrics.headshot_rate,
    snapshot.metrics.kills_per_match,
    snapshot.metrics.damage_per_match,
    snapshot.bestArp,
    profile.profileUpdatedAt,
    // Version zero is a real legacy parser version. Do not coerce it to the
    // current version, otherwise old snapshots leak into analytics.
    Number.isInteger(profile.parserVersion) && profile.parserVersion >= 0
      ? profile.parserVersion
      : ARENA_PARSER_VERSION,
    JSON.stringify({ sourceCounters, normalized: snapshot }),
    now,
    profile.aid,
  ];
}

export function initializeArenaSchema(db: {
  exec(sql: string): void;
  prepare(sql: string): { get(...values: unknown[]): unknown };
}): void {
  const historyExists = Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'arena_mode_stats_history'"
  ).get());
  db.exec(ARENA_STORAGE_SCHEMA);
  for (const table of ["arena_mode_stats", "arena_mode_stats_history"]) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN best_arp REAL`);
    } catch {
      /* column already exists */
    }
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_arena_mode_stats_best_arp
    ON arena_mode_stats(arena_mode, best_arp DESC)`);
  // Only the schema upgrade performs this write. Later cold starts remain
  // read-only and every new profile writes its own immutable history row.
  if (!historyExists) db.exec(ARENA_HISTORY_BACKFILL_SQL);
}

export function arenaUpsertStatements(
  db: { prepare(sql: string): { bind(...values: unknown[]): unknown } },
  profile: ArenaProfile,
  now = Date.now(),
): unknown[] {
  return storedSnapshots(profile).flatMap((snapshot) => {
    const values = valuesFor(profile, snapshot, now);
    return [
      db.prepare(ARENA_UPSERT_SQL).bind(...values),
      db.prepare(ARENA_HISTORY_INSERT_SQL).bind(...values),
    ];
  });
}

export function upsertArenaSqlite(
  db: { prepare(sql: string): { run(...values: unknown[]): unknown } },
  profile: ArenaProfile,
  now = Date.now(),
): void {
  for (const snapshot of storedSnapshots(profile)) {
    const values = valuesFor(profile, snapshot, now);
    db.prepare(ARENA_UPSERT_SQL).run(...values);
    db.prepare(ARENA_HISTORY_INSERT_SQL).run(...values);
  }
}

export function arenaRiskValues(risk: ArenaProfileRisk, now = Date.now()): unknown[] {
  const upstream = risk.version.upstream ?? 0;
  const parserVersion = risk.version.parser;
  const parser = typeof parserVersion === "number" && Number.isInteger(parserVersion) && parserVersion >= 0
    ? parserVersion
    : ARENA_PARSER_VERSION;
  return [risk.aid, upstream, parser, now, JSON.stringify(risk)];
}

export function isArenaMode(value: unknown): value is ArenaModeKey {
  return typeof value === "string" && (ARENA_MODE_KEYS as readonly string[]).includes(value);
}
