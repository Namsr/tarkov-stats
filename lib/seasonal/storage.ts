import type {
  CaptureSnapshotResult,
  PlayerProfileRecord,
  ProfileIdentity,
  ProgressionIntervalRecord,
  ProgressionSnapshotRecord,
  ScanTaskKind,
  ScanTaskPriority,
  ScanTaskRecord,
  SeasonalCounters,
  SeasonalAchievementUnlock,
  SeasonalProfile,
  SeasonalStore,
  SeasonCycle,
} from "@/types/seasonal";

// This module intentionally uses the small synchronous node:sqlite surface that
// the existing progression store already relies on. Keeping schema ownership in
// one place lets legacy rows be upgraded before either store reads them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SqliteDatabase = any;

const COUNTER_COLUMNS = [
  "experience",
  "pmc_raids",
  "scav_raids",
  "pmc_survived",
  "pmc_deaths",
  "pmc_kills",
  "killed_pmc",
] as const;

export const SEASONAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS excluded_players (
  aid INTEGER PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS season_cycles (
  mode TEXT NOT NULL CHECK (mode = 'seasonal'),
  cycle_id TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 0,
  upstream_contract TEXT CHECK (upstream_contract IN ('game_mode', 'profile_section', 'direct_profile')),
  PRIMARY KEY (mode, cycle_id)
);
CREATE TABLE IF NOT EXISTS player_profiles (
  mode TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  aid INTEGER NOT NULL,
  nickname TEXT NOT NULL,
  profile_updated_at INTEGER NOT NULL,
  last_access_at INTEGER NOT NULL,
  lifetime_pvp_hours REAL,
  experience INTEGER NOT NULL,
  pmc_raids INTEGER NOT NULL,
  scav_raids INTEGER NOT NULL,
  pmc_survived INTEGER NOT NULL,
  pmc_deaths INTEGER NOT NULL,
  pmc_kills INTEGER NOT NULL,
  killed_pmc INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  linked_pvp_achievements TEXT NOT NULL DEFAULT '[]',
  linked_pvp_achievement_count INTEGER,
  linked_pvp_profile_updated_at INTEGER,
  snapshot_count INTEGER NOT NULL DEFAULT 0,
  progression_eligible INTEGER NOT NULL DEFAULT 0,
  confirmed_banned INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (mode, cycle_id, aid)
);
CREATE INDEX IF NOT EXISTS idx_player_profiles_cycle_access
  ON player_profiles(mode, cycle_id, last_access_at);
CREATE INDEX IF NOT EXISTS idx_player_profiles_progression_hours
  ON player_profiles(mode, cycle_id, confirmed_banned, lifetime_pvp_hours, aid);
CREATE INDEX IF NOT EXISTS idx_player_profiles_average_freshness
  ON player_profiles(mode, cycle_id, confirmed_banned, profile_updated_at);
CREATE TABLE IF NOT EXISTS upstream_ban_confirmations (
  aid INTEGER NOT NULL,
  mode TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  source TEXT NOT NULL,
  confirmed_at INTEGER NOT NULL,
  PRIMARY KEY (aid, mode, cycle_id, source)
);
CREATE INDEX IF NOT EXISTS idx_upstream_ban_confirmations_aid
  ON upstream_ban_confirmations(aid);
INSERT OR IGNORE INTO upstream_ban_confirmations
  (aid, mode, cycle_id, source, confirmed_at)
SELECT p.aid, p.mode, p.cycle_id, 'legacy_unknown',
  MAX(p.profile_updated_at, p.last_seen_at)
FROM player_profiles p
WHERE p.confirmed_banned = 1
  AND NOT EXISTS (
    SELECT 1 FROM excluded_players e
    WHERE e.aid = p.aid AND e.reason = 'admin_manual'
  );
CREATE TABLE IF NOT EXISTS progression_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL DEFAULT 'regular',
  cycle_id TEXT NOT NULL DEFAULT 'persistent',
  aid INTEGER NOT NULL,
  profile_updated_at INTEGER NOT NULL,
  upstream_updated_at INTEGER NOT NULL,
  captured_at INTEGER NOT NULL,
  local_date TEXT NOT NULL,
  series_id INTEGER NOT NULL DEFAULT 1,
  nickname TEXT,
  side TEXT,
  prestige INTEGER,
  level INTEGER,
  experience INTEGER NOT NULL DEFAULT 0,
  hours REAL,
  total_raids INTEGER,
  pmc_raids INTEGER NOT NULL DEFAULT 0,
  scav_raids INTEGER NOT NULL DEFAULT 0,
  survived INTEGER,
  pmc_survived INTEGER NOT NULL DEFAULT 0,
  deaths INTEGER,
  pmc_deaths INTEGER NOT NULL DEFAULT 0,
  pmc_kills INTEGER NOT NULL DEFAULT 0,
  total_kills INTEGER,
  killed_pmc INTEGER NOT NULL DEFAULT 0,
  run_through INTEGER,
  longest_win_streak INTEGER,
  achv_count INTEGER,
  achievements TEXT,
  stats_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(mode, cycle_id, aid, profile_updated_at)
);
CREATE INDEX IF NOT EXISTS idx_progression_snapshots_identity_time
  ON progression_snapshots(mode, cycle_id, aid, profile_updated_at);
CREATE INDEX IF NOT EXISTS idx_progression_snapshots_cycle_date
  ON progression_snapshots(mode, cycle_id, local_date);
CREATE INDEX IF NOT EXISTS idx_progression_snapshots_cycle_raids_latest
  ON progression_snapshots(mode, cycle_id, pmc_raids, aid, profile_updated_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS progression_intervals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  aid INTEGER NOT NULL,
  from_snapshot_id INTEGER NOT NULL,
  to_snapshot_id INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  local_date TEXT NOT NULL,
  elapsed_days REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('valid', 'reset', 'schema_anomaly')),
  experience INTEGER NOT NULL,
  pmc_raids INTEGER NOT NULL,
  scav_raids INTEGER NOT NULL,
  pmc_survived INTEGER NOT NULL,
  pmc_deaths INTEGER NOT NULL,
  pmc_kills INTEGER NOT NULL,
  killed_pmc INTEGER NOT NULL,
  tempo_score REAL,
  form_score REAL,
  score_sample_n INTEGER,
  confidence REAL NOT NULL DEFAULT 0,
  score_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(mode, cycle_id, aid, from_snapshot_id, to_snapshot_id)
);
CREATE INDEX IF NOT EXISTS idx_progression_intervals_cycle_date
  ON progression_intervals(mode, cycle_id, local_date);
CREATE INDEX IF NOT EXISTS idx_progression_intervals_cycle_valid_end
  ON progression_intervals(mode, cycle_id, status, to_snapshot_id, aid, ended_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS daily_aggregates (
  mode TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  local_date TEXT NOT NULL,
  kind TEXT NOT NULL,
  dimension TEXT NOT NULL,
  bucket_min REAL NOT NULL,
  bucket_max REAL,
  mean REAL NOT NULL,
  p25 REAL,
  p75 REAL,
  n INTEGER NOT NULL,
  confidence REAL NOT NULL,
  freshness_at INTEGER NOT NULL,
  score_version INTEGER NOT NULL,
  PRIMARY KEY (mode, cycle_id, local_date, kind, dimension, bucket_min)
);
CREATE TABLE IF NOT EXISTS progression_materializations (
  mode TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  materialized_at INTEGER NOT NULL DEFAULT 0,
  score_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (mode, cycle_id)
);
CREATE TABLE IF NOT EXISTS scan_cohorts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  name TEXT NOT NULL,
  target_size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(mode, cycle_id, name)
);
CREATE TABLE IF NOT EXISTS scan_candidates (
  mode TEXT NOT NULL CHECK (mode = 'seasonal'),
  cycle_id TEXT NOT NULL,
  aid INTEGER NOT NULL,
  nickname TEXT,
  lifetime_pvp_hours REAL,
  lifetime_source TEXT,
  discovered_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (mode, cycle_id, aid)
);
CREATE TABLE IF NOT EXISTS scan_discovery_state (
  mode TEXT NOT NULL CHECK (mode = 'seasonal'),
  cycle_id TEXT NOT NULL,
  cursor_key INTEGER NOT NULL DEFAULT -1,
  cursor_aid INTEGER NOT NULL DEFAULT 0,
  exhausted INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (mode, cycle_id)
);
CREATE TABLE IF NOT EXISTS scan_daily_requeues (
  mode TEXT NOT NULL CHECK (mode = 'seasonal'),
  cycle_id TEXT NOT NULL,
  local_date TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (mode, cycle_id, local_date)
);
CREATE TABLE IF NOT EXISTS scan_members (
  mode TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  aid INTEGER NOT NULL,
  cohort_id INTEGER,
  lifetime_band INTEGER,
  joined_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (mode, cycle_id, aid)
);
CREATE TABLE IF NOT EXISTS scan_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  aid INTEGER NOT NULL,
  kind TEXT NOT NULL,
  priority INTEGER NOT NULL,
  state TEXT NOT NULL,
  previous_profile_updated_at INTEGER,
  lease_owner TEXT,
  leased_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(mode, cycle_id, aid, kind)
);
CREATE INDEX IF NOT EXISTS idx_scan_tasks_claim
  ON scan_tasks(state, priority, available_at, leased_until);
CREATE TABLE IF NOT EXISTS scan_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  state TEXT NOT NULL,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_scan_runs_active_owner
  ON scan_runs(mode, cycle_id, owner) WHERE state = 'running';
CREATE TABLE IF NOT EXISTS helper_sessions (
  helper_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  polling_until INTEGER NOT NULL
);
`;

function columns(db: SqliteDatabase, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name));
}

/** Upgrade the original aid-only snapshot table without losing its history. */
export function initializeSeasonalSchema(db: SqliteDatabase): void {
  const snapshotColumns = columns(db, "progression_snapshots");
  if (snapshotColumns.size > 0 && !snapshotColumns.has("mode")) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("ALTER TABLE progression_snapshots RENAME TO progression_snapshots_legacy");
      db.exec(SEASONAL_SCHEMA);
      db.exec(`
        INSERT INTO progression_snapshots (
          id, mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at,
          local_date, series_id, nickname, side, prestige, level, experience, hours,
          total_raids, pmc_raids, scav_raids, survived, pmc_survived, deaths, pmc_deaths,
          pmc_kills, total_kills, killed_pmc, run_through, longest_win_streak, achv_count,
          achievements, stats_json
        )
        SELECT id, 'regular', 'persistent', aid, upstream_updated_at, upstream_updated_at,
          captured_at, strftime('%Y-%m-%d', upstream_updated_at / 1000, 'unixepoch', '+3 hours'), series_id,
          nickname, side, prestige, level, experience, hours, total_raids, pmc_raids,
          scav_raids, survived, COALESCE(json_extract(stats_json, '$.pmcSurvived'), survived),
          deaths, pmc_deaths, COALESCE(json_extract(stats_json, '$.pmcKills'), total_kills), total_kills,
          killed_pmc, run_through, longest_win_streak, achv_count, achievements, stats_json
        FROM progression_snapshots_legacy;
        DROP TABLE progression_snapshots_legacy;
      `);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } else {
    db.exec(SEASONAL_SCHEMA);
  }
  ensureSeasonalContractConstraint(db);
  ensureNullablePortraitColumns(db);
  if (!columns(db, "player_profiles").has("progression_eligible")) {
    db.exec("ALTER TABLE player_profiles ADD COLUMN progression_eligible INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns(db, "player_profiles").has("linked_pvp_achievements")) {
    db.exec("ALTER TABLE player_profiles ADD COLUMN linked_pvp_achievements TEXT NOT NULL DEFAULT '[]'");
  }
  if (!columns(db, "player_profiles").has("linked_pvp_profile_updated_at")) {
    db.exec("ALTER TABLE player_profiles ADD COLUMN linked_pvp_profile_updated_at INTEGER");
  }
  if (!columns(db, "player_profiles").has("linked_pvp_achievement_count")) {
    db.exec("ALTER TABLE player_profiles ADD COLUMN linked_pvp_achievement_count INTEGER");
    db.exec(`UPDATE player_profiles SET linked_pvp_achievement_count = CASE
      WHEN linked_pvp_profile_updated_at IS NOT NULL AND json_valid(linked_pvp_achievements)
        THEN json_array_length(linked_pvp_achievements) ELSE NULL END`);
  }
  if (!columns(db, "progression_intervals").has("score_sample_n")) {
    db.exec("ALTER TABLE progression_intervals ADD COLUMN score_sample_n INTEGER");
  }
}

/**
 * Older Seasonal deployments created the portrait columns as NOT NULL with
 * zero defaults. Rebuild that table once so a missing upstream counter can be
 * represented as NULL; progression ids and interval references are retained.
 */
function ensureNullablePortraitColumns(db: SqliteDatabase): void {
  const info = db.prepare("PRAGMA table_info(progression_snapshots)").all() as {
    name: string;
    notnull: number;
  }[];
  const portrait = new Set([
    "prestige", "level", "hours", "total_raids", "survived", "deaths", "total_kills",
    "run_through", "longest_win_streak", "achv_count", "achievements",
  ]);
  if (!info.length || !info.some((column) => portrait.has(column.name) && Number(column.notnull) === 1)) return;

  const columnsToCopy = [
    "id", "mode", "cycle_id", "aid", "profile_updated_at", "upstream_updated_at", "captured_at",
    "local_date", "series_id", "nickname", "side", "prestige", "level", "experience", "hours",
    "total_raids", "pmc_raids", "scav_raids", "survived", "pmc_survived", "deaths", "pmc_deaths",
    "pmc_kills", "total_kills", "killed_pmc", "run_through", "longest_win_streak", "achv_count",
    "achievements", "stats_json",
  ];
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      DROP INDEX IF EXISTS idx_progression_snapshots_identity_time;
      DROP INDEX IF EXISTS idx_progression_snapshots_cycle_date;
      DROP INDEX IF EXISTS idx_progression_snapshots_cycle_raids_latest;
      ALTER TABLE progression_snapshots RENAME TO progression_snapshots_legacy;
      CREATE TABLE progression_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mode TEXT NOT NULL DEFAULT 'regular',
        cycle_id TEXT NOT NULL DEFAULT 'persistent',
        aid INTEGER NOT NULL,
        profile_updated_at INTEGER NOT NULL,
        upstream_updated_at INTEGER NOT NULL,
        captured_at INTEGER NOT NULL,
        local_date TEXT NOT NULL,
        series_id INTEGER NOT NULL DEFAULT 1,
        nickname TEXT,
        side TEXT,
        prestige INTEGER,
        level INTEGER,
        experience INTEGER NOT NULL DEFAULT 0,
        hours REAL,
        total_raids INTEGER,
        pmc_raids INTEGER NOT NULL DEFAULT 0,
        scav_raids INTEGER NOT NULL DEFAULT 0,
        survived INTEGER,
        pmc_survived INTEGER NOT NULL DEFAULT 0,
        deaths INTEGER,
        pmc_deaths INTEGER NOT NULL DEFAULT 0,
        pmc_kills INTEGER NOT NULL DEFAULT 0,
        total_kills INTEGER,
        killed_pmc INTEGER NOT NULL DEFAULT 0,
        run_through INTEGER,
        longest_win_streak INTEGER,
        achv_count INTEGER,
        achievements TEXT,
        stats_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(mode, cycle_id, aid, profile_updated_at)
      );
      INSERT INTO progression_snapshots (${columnsToCopy.join(", ")})
        SELECT ${columnsToCopy.join(", ")} FROM progression_snapshots_legacy;
      DROP TABLE progression_snapshots_legacy;
      CREATE INDEX idx_progression_snapshots_identity_time
        ON progression_snapshots(mode, cycle_id, aid, profile_updated_at);
      CREATE INDEX idx_progression_snapshots_cycle_date
        ON progression_snapshots(mode, cycle_id, local_date);
      CREATE INDEX idx_progression_snapshots_cycle_raids_latest
        ON progression_snapshots(mode, cycle_id, pmc_raids, aid, profile_updated_at DESC, id DESC);
      UPDATE progression_snapshots SET
        prestige = NULLIF(prestige, 0), level = NULLIF(level, 0), hours = NULLIF(hours, 0),
        total_raids = NULLIF(total_raids, 0), survived = NULLIF(survived, 0), deaths = NULLIF(deaths, 0),
        total_kills = NULLIF(total_kills, 0), run_through = NULLIF(run_through, 0),
        longest_win_streak = NULLIF(longest_win_streak, 0), achv_count = NULLIF(achv_count, 0),
        achievements = CASE WHEN achievements IS NULL OR achievements = '' THEN NULL ELSE achievements END
        WHERE mode = 'seasonal';
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Upgrade installations created before the direct raw-profile contract existed. */
function ensureSeasonalContractConstraint(db: SqliteDatabase): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'season_cycles'").get() as
    | { sql?: string }
    | undefined;
  if (!row?.sql || row.sql.includes("direct_profile")) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("ALTER TABLE season_cycles RENAME TO season_cycles_legacy");
    db.exec(`CREATE TABLE season_cycles (
      mode TEXT NOT NULL CHECK (mode = 'seasonal'),
      cycle_id TEXT NOT NULL,
      starts_at INTEGER NOT NULL,
      ends_at INTEGER,
      enabled INTEGER NOT NULL DEFAULT 0,
      upstream_contract TEXT CHECK (upstream_contract IN ('game_mode', 'profile_section', 'direct_profile')),
      PRIMARY KEY (mode, cycle_id)
    )`);
    db.exec(`INSERT INTO season_cycles (mode, cycle_id, starts_at, ends_at, enabled, upstream_contract)
      SELECT mode, cycle_id, starts_at, ends_at, enabled, upstream_contract FROM season_cycles_legacy`);
    db.exec("DROP TABLE season_cycles_legacy");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function upsertSqliteSeasonCycle(db: SqliteDatabase, cycle: import("@/types/seasonal").SeasonCycle): void {
  db.prepare(`INSERT INTO season_cycles (mode, cycle_id, starts_at, ends_at, enabled, upstream_contract)
    VALUES ('seasonal', ?, ?, ?, ?, ?)
    ON CONFLICT(mode, cycle_id) DO UPDATE SET starts_at = excluded.starts_at,
      ends_at = excluded.ends_at, enabled = excluded.enabled, upstream_contract = excluded.upstream_contract`)
    .run(cycle.cycleId, cycle.startsAt, cycle.endsAt, cycle.enabled ? 1 : 0, cycle.upstreamContract);
}

/** Calendar date in the product's fixed Europe/Moscow reporting timezone. */
export function moscowDate(timestamp: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function counterArgs(c: SeasonalCounters): number[] {
  return [c.experience, c.pmcRaids, c.scavRaids, c.pmcSurvived, c.pmcDeaths, c.pmcKills, c.killedPmc];
}

export function rowCounters(row: Record<string, unknown>): SeasonalCounters {
  return {
    experience: Number(row.experience),
    pmcRaids: Number(row.pmc_raids),
    scavRaids: Number(row.scav_raids),
    pmcSurvived: Number(row.pmc_survived),
    pmcDeaths: Number(row.pmc_deaths),
    pmcKills: Number(row.pmc_kills),
    killedPmc: Number(row.killed_pmc),
  };
}

/**
 * Reads both the legacy `string[]` snapshot format and the current
 * `{id, unlockedAt}[]` format. A malformed/non-array payload is unknown, not
 * an empty achievement list, so callers can exclude it from a denominator.
 */
export function parseSeasonalAchievementUnlocks(
  value: unknown,
): SeasonalAchievementUnlock[] | null {
  if (value == null) return null;
  let parsed: unknown = value;
  if (typeof value === "string") {
    if (value.trim() === "") return null;
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed)) return null;

  const result = new Map<string, SeasonalAchievementUnlock>();
  for (const item of parsed) {
    let id: string;
    let unlockedAt: number | null = null;
    if (typeof item === "string") {
      id = item.trim();
    } else if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      const row = item as { id?: unknown; unlockedAt?: unknown };
      id = typeof row.id === "string" ? row.id.trim() : "";
      if (row.unlockedAt !== null && row.unlockedAt !== undefined) {
        const timestamp = Number(row.unlockedAt);
        if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
        unlockedAt = Math.trunc(timestamp);
      }
    } else {
      return null;
    }
    if (!id) return null;
    const previous = result.get(id);
    if (!previous || (previous.unlockedAt === null && unlockedAt !== null)) {
      result.set(id, { id, unlockedAt });
    }
  }
  return [...result.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function serializeSeasonalAchievementUnlocks(
  achievements: SeasonalAchievementUnlock[] | null,
): string | null {
  return achievements === null ? null : JSON.stringify(achievements);
}

/** Converts an ingested profile into the snapshot payload without erasing legacy data. */
export function seasonalAchievementSnapshotValue(profile: SeasonalProfile): {
  value: string | null;
  count: number | null;
} {
  if (profile.seasonalAchievements !== undefined) {
    return {
      value: serializeSeasonalAchievementUnlocks(profile.seasonalAchievements),
      count: profile.seasonalAchievements?.length ?? null,
    };
  }
  if (profile.staticSignals !== undefined) {
    // Legacy callers only provide ids. Preserve that representation while the
    // dual-reader above makes it safe to consume alongside new captures.
    return {
      value: JSON.stringify(profile.staticSignals.achievementIds),
      count: profile.staticSignals.achievementIds.length,
    };
  }
  return { value: null, count: null };
}

export function toSnapshot(row: Record<string, unknown> | undefined): ProgressionSnapshotRecord | null {
  if (!row) return null;
  return {
    id: Number(row.id), mode: String(row.mode) as ProfileIdentity["mode"], cycleId: String(row.cycle_id),
    aid: Number(row.aid), profileUpdatedAt: Number(row.profile_updated_at), capturedAt: Number(row.captured_at),
    localDate: String(row.local_date), seriesId: Number(row.series_id), counters: rowCounters(row),
    achievements: parseSeasonalAchievementUnlocks(row.achievements),
  };
}

function nullableNumber(value: unknown): number | null {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function quotient(numerator: number | null, denominator: number | null): number | null {
  if (numerator == null || denominator == null) return null;
  return denominator > 0 ? numerator / denominator : numerator;
}

function percentage(numerator: number | null, denominator: number | null): number | null {
  if (numerator == null || denominator == null || denominator <= 0) return null;
  return numerator / denominator * 100;
}

export function toProfile(
  row: Record<string, unknown>,
  snapshot?: Record<string, unknown>,
): PlayerProfileRecord {
  let achievementIds: string[] = [];
  try {
    const parsed = JSON.parse(String(row.linked_pvp_achievements ?? "[]"));
    if (Array.isArray(parsed)) achievementIds = parsed.filter((value): value is string => typeof value === "string");
  } catch {
    achievementIds = [];
  }
  const profile: PlayerProfileRecord = {
    mode: String(row.mode) as ProfileIdentity["mode"], cycleId: String(row.cycle_id), aid: Number(row.aid),
    nickname: String(row.nickname), profileUpdatedAt: Number(row.profile_updated_at),
    lastAccessAt: Number(row.last_access_at), lifetimePvpHours: row.lifetime_pvp_hours == null ? null : Number(row.lifetime_pvp_hours),
    counters: rowCounters(row), firstSeenAt: Number(row.first_seen_at), lastSeenAt: Number(row.last_seen_at),
    pvpEnrichment: {
      lifetimeHours: row.lifetime_pvp_hours == null ? null : Number(row.lifetime_pvp_hours),
      achievementIds,
      achievementCount: row.linked_pvp_achievement_count == null
        ? (row.linked_pvp_profile_updated_at == null ? null : achievementIds.length)
        : Number(row.linked_pvp_achievement_count),
      profileUpdatedAt: row.linked_pvp_profile_updated_at == null ? null : Number(row.linked_pvp_profile_updated_at),
    },
    snapshotCount: Number(row.snapshot_count), confirmedBanned: Number(row.confirmed_banned) === 1,
  };

  // The durable portrait fields live in the latest progression snapshot. Only
  // hydrate a snapshot that belongs to the same profile version; otherwise the
  // counters above are still a safe, current fallback without stale portrait
  // data from an older capture.
  if (snapshot && Number(snapshot.profile_updated_at) === profile.profileUpdatedAt) {
    const achievements = parseSeasonalAchievementUnlocks(snapshot.achievements);
    const totalRaids = nullableNumber(snapshot.total_raids);
    const survivedRaids = nullableNumber(snapshot.survived);
    const totalKills = nullableNumber(snapshot.total_kills);
    const deaths = nullableNumber(snapshot.deaths);
    profile.seasonalStats = {
      totalRaids,
      survivedRaids,
      totalKills,
      deaths,
      runThrough: nullableNumber(snapshot.run_through),
      survivalRate: percentage(survivedRaids, totalRaids),
      kdRatio: quotient(totalKills, deaths),
      pmcKdRatio: quotient(profile.counters.killedPmc, profile.counters.pmcDeaths),
      killsPerRaid: quotient(totalKills, totalRaids),
      pmcSurvivalRate: percentage(profile.counters.pmcSurvived, profile.counters.pmcRaids),
      level: nullableNumber(snapshot.level),
      prestige: nullableNumber(snapshot.prestige),
      longestWinStreak: nullableNumber(snapshot.longest_win_streak),
      achievementsCount: nullableNumber(snapshot.achv_count) ?? (achievements === null ? null : achievements.length),
    };
    profile.seasonalAchievements = achievements;
    profile.staticSignals = {
      prestige: nullableNumber(snapshot.prestige) ?? 0,
      longestWinStreak: nullableNumber(snapshot.longest_win_streak) ?? 0,
      achievementIds: achievements?.map((achievement) => achievement.id) ?? [],
    };
  }

  return profile;
}

export function toScanTask(row: Record<string, unknown>): ScanTaskRecord {
  return {
    id: Number(row.id),
    mode: String(row.mode) as ProfileIdentity["mode"],
    cycleId: String(row.cycle_id),
    aid: Number(row.aid),
    kind: String(row.kind) as ScanTaskRecord["kind"],
    priority: Number(row.priority) as ScanTaskRecord["priority"],
    state: String(row.state) as ScanTaskRecord["state"],
    previousProfileUpdatedAt: row.previous_profile_updated_at == null ? null : Number(row.previous_profile_updated_at),
    leaseOwner: row.lease_owner == null ? null : String(row.lease_owner),
    leasedUntil: row.leased_until == null ? null : Number(row.leased_until),
    attempts: Number(row.attempts),
    availableAt: Number(row.available_at),
  };
}

export function validateProfile(profile: SeasonalProfile): void {
  if (profile.mode !== "seasonal") throw new Error("seasonal store only accepts seasonal profiles");
  if (!profile.cycleId) throw new Error("cycleId is required");
  if (!Number.isSafeInteger(profile.aid) || profile.aid <= 0) throw new Error("invalid aid");
  if (!Number.isFinite(profile.profileUpdatedAt) || profile.profileUpdatedAt <= 0) throw new Error("invalid profileUpdatedAt");
  for (const value of counterArgs(profile.counters)) if (!Number.isFinite(value) || value < 0) throw new Error("invalid counter");
}

export function validateTaskIdentity(identity: ProfileIdentity): void {
  if (identity.mode !== "seasonal") throw new Error("seasonal queue only accepts seasonal tasks");
  if (!identity.cycleId.trim()) throw new Error("task cycleId is required");
  if (!Number.isSafeInteger(identity.aid) || identity.aid <= 0) throw new Error("invalid task aid");
}

export function validateTaskKind(kind: ScanTaskKind): void {
  if (!(["profile", "linked_pvp", "ban_check"] as const).includes(kind)) {
    throw new Error("invalid task kind");
  }
}

export function validateTaskPriority(priority: ScanTaskPriority): void {
  if (![1, 2, 3, 4].includes(priority)) throw new Error("invalid task priority");
}

export function createSqliteSeasonalStore(db: SqliteDatabase): SeasonalStore {
  initializeSeasonalSchema(db);
  const identityWhere = "mode = ? AND cycle_id = ? AND aid = ?";
  return {
    async getCycle(cycleId) {
      const row = db.prepare("SELECT * FROM season_cycles WHERE mode = 'seasonal' AND cycle_id = ?").get(cycleId) as Record<string, unknown> | undefined;
      return row ? {
        mode: "seasonal", cycleId: String(row.cycle_id), startsAt: Number(row.starts_at),
        endsAt: row.ends_at == null ? null : Number(row.ends_at), enabled: Number(row.enabled) === 1,
        upstreamContract: row.upstream_contract == null ? null : String(row.upstream_contract) as SeasonCycle["upstreamContract"],
      } : null;
    },
    async getProfile(identity) {
      const row = db.prepare(`SELECT * FROM player_profiles WHERE ${identityWhere}`).get(identity.mode, identity.cycleId, identity.aid) as Record<string, unknown> | undefined;
      if (!row) return null;
      const snapshot = db.prepare(`SELECT * FROM progression_snapshots WHERE ${identityWhere} ORDER BY profile_updated_at DESC LIMIT 1`).get(identity.mode, identity.cycleId, identity.aid) as Record<string, unknown> | undefined;
      return toProfile(row, snapshot);
    },
    async upsertProfile(profile, observedAt = Date.now()) {
      validateProfile(profile);
      db.prepare(`
        INSERT INTO player_profiles (
          mode, cycle_id, aid, nickname, profile_updated_at, last_access_at, lifetime_pvp_hours,
          ${COUNTER_COLUMNS.join(", ")}, first_seen_at, last_seen_at, confirmed_banned
        ) VALUES (${Array.from({ length: 16 }, () => "?").join(", ")},
          EXISTS(SELECT 1 FROM excluded_players WHERE aid = ?))
        ON CONFLICT(mode, cycle_id, aid) DO UPDATE SET
          nickname = excluded.nickname,
          profile_updated_at = MAX(player_profiles.profile_updated_at, excluded.profile_updated_at),
          last_access_at = MAX(player_profiles.last_access_at, excluded.last_access_at),
          lifetime_pvp_hours = COALESCE(player_profiles.lifetime_pvp_hours, excluded.lifetime_pvp_hours),
          experience = CASE WHEN excluded.profile_updated_at >= player_profiles.profile_updated_at THEN excluded.experience ELSE player_profiles.experience END,
          pmc_raids = CASE WHEN excluded.profile_updated_at >= player_profiles.profile_updated_at THEN excluded.pmc_raids ELSE player_profiles.pmc_raids END,
          scav_raids = CASE WHEN excluded.profile_updated_at >= player_profiles.profile_updated_at THEN excluded.scav_raids ELSE player_profiles.scav_raids END,
          pmc_survived = CASE WHEN excluded.profile_updated_at >= player_profiles.profile_updated_at THEN excluded.pmc_survived ELSE player_profiles.pmc_survived END,
          pmc_deaths = CASE WHEN excluded.profile_updated_at >= player_profiles.profile_updated_at THEN excluded.pmc_deaths ELSE player_profiles.pmc_deaths END,
          pmc_kills = CASE WHEN excluded.profile_updated_at >= player_profiles.profile_updated_at THEN excluded.pmc_kills ELSE player_profiles.pmc_kills END,
          killed_pmc = CASE WHEN excluded.profile_updated_at >= player_profiles.profile_updated_at THEN excluded.killed_pmc ELSE player_profiles.killed_pmc END,
          last_seen_at = MAX(player_profiles.last_seen_at, excluded.last_seen_at),
          confirmed_banned = CASE
            WHEN EXISTS(SELECT 1 FROM excluded_players WHERE aid = excluded.aid) THEN 1
            ELSE player_profiles.confirmed_banned END
      `).run(profile.mode, profile.cycleId, profile.aid, profile.nickname, profile.profileUpdatedAt,
        profile.lastAccessAt, profile.lifetimePvpHours, ...counterArgs(profile.counters), observedAt, observedAt,
        profile.aid);
      return toProfile(db.prepare(`SELECT * FROM player_profiles WHERE ${identityWhere}`).get(profile.mode, profile.cycleId, profile.aid));
    },
    async captureSnapshot(profile, capturedAt = Date.now()) {
      validateProfile(profile);
      const identity = [profile.mode, profile.cycleId, profile.aid];
      if (db.prepare("SELECT 1 FROM excluded_players WHERE aid = ?").get(profile.aid)) {
        return { inserted: false, status: "banned", snapshot: null, interval: null } as CaptureSnapshotResult;
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const previous = toSnapshot(db.prepare(`SELECT * FROM progression_snapshots WHERE ${identityWhere} ORDER BY profile_updated_at DESC LIMIT 1`).get(...identity));
        if (previous && profile.profileUpdatedAt <= previous.profileUpdatedAt) {
          // A replayed JSON payload is also the idempotent portrait backfill
          // path: refresh only Seasonal-derived fields on the existing row and
          // never create a second progression point.
          if (profile.profileUpdatedAt === previous.profileUpdatedAt && profile.seasonalStats !== undefined) {
            const stats = profile.seasonalStats;
            const achievementSnapshot = seasonalAchievementSnapshotValue(profile);
            db.prepare(`UPDATE progression_snapshots SET
              total_raids = ?, survived = ?, deaths = ?, total_kills = ?, run_through = ?,
              level = ?, prestige = ?, longest_win_streak = ?,
              achv_count = COALESCE(?, achv_count), achievements = COALESCE(?, achievements)
              WHERE ${identityWhere} AND profile_updated_at = ?`).run(
              stats.totalRaids, stats.survivedRaids, stats.deaths, stats.totalKills,
              stats.runThrough, stats.level, stats.prestige, stats.longestWinStreak,
              achievementSnapshot.count, achievementSnapshot.value,
              ...identity, profile.profileUpdatedAt,
            );
          }
          db.exec("COMMIT");
          return { inserted: false, status: profile.profileUpdatedAt === previous.profileUpdatedAt ? "duplicate" : "stale", snapshot: null, interval: null };
        }
        const changes = previous ? Object.fromEntries(Object.keys(profile.counters).map((key) => {
          const current = Number(profile.counters[key as keyof SeasonalCounters] ?? 0);
          const before = Number(previous.counters[key as keyof SeasonalCounters] ?? 0);
          return [key, current - before];
        })) as unknown as SeasonalCounters : null;
        const negative = changes ? Object.values(changes).some((value) => value < 0) : false;
        const intervalStatus: ProgressionIntervalRecord["status"] = !changes || !negative
          ? "valid"
          : changes.experience < 0 && changes.pmcRaids < 0
            ? "reset"
            : "schema_anomaly";
        const seriesId = previous ? previous.seriesId + (negative ? 1 : 0) : 1;
        const staticSignals = profile.staticSignals ?? {
          prestige: 0,
          longestWinStreak: 0,
          achievementIds: [],
        };
        const hasStaticSignals = profile.staticSignals !== undefined;
        const seasonalStats = profile.seasonalStats;
        const achievementSnapshot = seasonalAchievementSnapshotValue(profile);
        const inserted = db.prepare(`INSERT INTO progression_snapshots (
          mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at, local_date, series_id,
          experience, total_raids, pmc_raids, scav_raids, survived, pmc_survived, deaths, pmc_deaths,
          pmc_kills, total_kills, killed_pmc, run_through, level, prestige, longest_win_streak, achv_count, achievements
        ) VALUES (${Array.from({ length: 25 }, () => "?").join(", ")})`).run(...identity, profile.profileUpdatedAt,
          profile.profileUpdatedAt, capturedAt, moscowDate(profile.profileUpdatedAt), seriesId,
          profile.counters.experience, seasonalStats?.totalRaids ?? null, profile.counters.pmcRaids,
          profile.counters.scavRaids, seasonalStats?.survivedRaids ?? null, profile.counters.pmcSurvived,
          seasonalStats?.deaths ?? null, profile.counters.pmcDeaths, profile.counters.pmcKills,
          seasonalStats?.totalKills ?? null, profile.counters.killedPmc, seasonalStats?.runThrough ?? null,
          seasonalStats?.level ?? null,
          seasonalStats !== undefined
            ? seasonalStats.prestige
            : hasStaticSignals ? staticSignals.prestige : null,
          seasonalStats !== undefined
            ? seasonalStats.longestWinStreak
            : hasStaticSignals ? staticSignals.longestWinStreak : null,
          achievementSnapshot.count,
          achievementSnapshot.value);
        const snapshot = toSnapshot(db.prepare("SELECT * FROM progression_snapshots WHERE id = ?").get(Number(inserted.lastInsertRowid)))!;
        let interval: ProgressionIntervalRecord | null = null;
        if (previous && changes) {
          const elapsedDays = (profile.profileUpdatedAt - previous.profileUpdatedAt) / 86_400_000;
          const intervalInsert = db.prepare(`INSERT INTO progression_intervals (
            mode, cycle_id, aid, from_snapshot_id, to_snapshot_id, ended_at, local_date, elapsed_days,
            status, experience, pmc_raids, scav_raids, pmc_survived, pmc_deaths, pmc_kills, killed_pmc,
            confidence, score_version
          ) VALUES (${Array.from({ length: 18 }, () => "?").join(", ")})`).run(...identity, previous.id, snapshot.id,
            profile.profileUpdatedAt, moscowDate(profile.profileUpdatedAt), elapsedDays, intervalStatus,
            ...counterArgs(changes), intervalStatus === "valid" ? Math.min(1, 1 / elapsedDays) : 0, 1);
          interval = {
            ...identityObject(profile), id: Number(intervalInsert.lastInsertRowid), fromSnapshotId: previous.id,
            toSnapshotId: snapshot.id, endedAt: profile.profileUpdatedAt, localDate: moscowDate(profile.profileUpdatedAt),
            elapsedDays, status: intervalStatus, changes, tempoScore: null, formScore: null,
            scoreSampleN: null,
            confidence: intervalStatus === "valid" ? Math.min(1, 1 / elapsedDays) : 0, scoreVersion: 1,
          };
        }
        db.prepare(`UPDATE player_profiles SET snapshot_count = snapshot_count + 1 WHERE ${identityWhere}`).run(...identity);
        db.exec("COMMIT");
        return {
          inserted: true,
          status: previous
            ? intervalStatus === "reset" ? "reset" : intervalStatus === "schema_anomaly" ? "schema_anomaly" : "progression"
            : "baseline",
          snapshot,
          interval,
        } as CaptureSnapshotResult;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async latestSnapshot(identity) {
      return toSnapshot(db.prepare(`SELECT * FROM progression_snapshots WHERE ${identityWhere} ORDER BY profile_updated_at DESC LIMIT 1`).get(identity.mode, identity.cycleId, identity.aid));
    },
    async snapshotHistory(identity) {
      return (db.prepare(`SELECT * FROM progression_snapshots WHERE ${identityWhere} ORDER BY profile_updated_at`).all(identity.mode, identity.cycleId, identity.aid) as Record<string, unknown>[])
        .map((row) => toSnapshot(row)!);
    },
    async enqueueTask({ kind, priority, previousProfileUpdatedAt = null, availableAt, now = Date.now(), ...identity }) {
      validateTaskIdentity(identity);
      validateTaskKind(kind);
      validateTaskPriority(priority);
      const readyAt = availableAt ?? now;
      if (!Number.isFinite(readyAt)) throw new Error("invalid task availableAt");
      if (previousProfileUpdatedAt != null && !Number.isFinite(previousProfileUpdatedAt)) {
        throw new Error("invalid previousProfileUpdatedAt");
      }
      db.prepare(`
        INSERT INTO scan_tasks (
          mode, cycle_id, aid, kind, priority, state, previous_profile_updated_at,
          available_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
        ON CONFLICT(mode, cycle_id, aid, kind) DO UPDATE SET
          priority = MIN(scan_tasks.priority, excluded.priority),
          previous_profile_updated_at = COALESCE(excluded.previous_profile_updated_at, scan_tasks.previous_profile_updated_at),
          available_at = MIN(scan_tasks.available_at, excluded.available_at),
          state = CASE WHEN scan_tasks.state IN ('queued', 'leased') THEN scan_tasks.state ELSE 'queued' END,
          lease_owner = CASE WHEN scan_tasks.state = 'leased' THEN scan_tasks.lease_owner ELSE NULL END,
          leased_until = CASE WHEN scan_tasks.state = 'leased' THEN scan_tasks.leased_until ELSE NULL END,
          consecutive_errors = CASE WHEN scan_tasks.state IN ('queued', 'leased') THEN scan_tasks.consecutive_errors ELSE 0 END,
          updated_at = excluded.updated_at
      `).run(identity.mode, identity.cycleId, identity.aid, kind, priority,
        previousProfileUpdatedAt, readyAt, now, now);
      return toScanTask(db.prepare(`
        SELECT * FROM scan_tasks WHERE mode = ? AND cycle_id = ? AND aid = ? AND kind = ?
      `).get(identity.mode, identity.cycleId, identity.aid, kind));
    },
    async claimTasks({ mode, cycleId, actor, owner, limit, now = Date.now() }) {
      validateTaskIdentity({ mode, cycleId, aid: 1 });
      if (actor !== "helper" && actor !== "operator") throw new Error("invalid task actor");
      if (!owner.trim()) throw new Error("task lease owner is required");
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid task claim limit");
      const leasedUntil = now + 5 * 60_000;
      db.exec("BEGIN IMMEDIATE");
      try {
        const rows = db.prepare(`
          SELECT * FROM scan_tasks
          WHERE mode = ? AND cycle_id = ?
            AND available_at <= ?
            AND kind ${actor === "operator" ? "IN ('profile', 'linked_pvp', 'ban_check')" : "IN ('profile', 'linked_pvp')"}
            AND (state = 'queued' OR (state = 'leased' AND leased_until <= ?))
          ORDER BY priority ASC, available_at ASC, created_at ASC, id ASC
          LIMIT ?
        `).all(mode, cycleId, now, now, limit) as Record<string, unknown>[];
        const update = db.prepare(`
          UPDATE scan_tasks
          SET state = 'leased', lease_owner = ?, leased_until = ?, attempts = attempts + 1, updated_at = ?
          WHERE id = ?
            AND (state = 'queued' OR (state = 'leased' AND leased_until <= ?))
        `);
        const claimed: ScanTaskRecord[] = [];
        for (const row of rows) {
          const result = update.run(owner, leasedUntil, now, Number(row.id), now);
          if (Number(result.changes) === 1) {
            claimed.push(toScanTask(db.prepare("SELECT * FROM scan_tasks WHERE id = ?").get(Number(row.id))));
          }
        }
        db.exec("COMMIT");
        return claimed;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

export function identityObject(profile: SeasonalProfile): ProfileIdentity {
  return { mode: profile.mode, cycleId: profile.cycleId, aid: profile.aid };
}

let database: SqliteDatabase | null = null;

export async function getSeasonalStore(): Promise<SeasonalStore | null> {
  const { loadSeasonalCycleConfig } = await import("./config");
  const configuredCycle = loadSeasonalCycleConfig();
  const { getSeasonalD1 } = await import("./d1");
  const d1 = await getSeasonalD1();
  if (d1) {
    const { createD1SeasonalStore, upsertD1SeasonCycle } = await import("./storage-d1");
    if (configuredCycle) await upsertD1SeasonCycle(d1, configuredCycle);
    return createD1SeasonalStore(d1);
  }
  if (database) {
    if (configuredCycle) upsertSqliteSeasonCycle(database, configuredCycle);
    return createSqliteSeasonalStore(database);
  }
  try {
    const sqlite = (await import("node:sqlite" as string)) as { DatabaseSync: new (path: string) => SqliteDatabase };
    database = new sqlite.DatabaseSync(process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db");
    const store = createSqliteSeasonalStore(database);
    if (configuredCycle) upsertSqliteSeasonCycle(database, configuredCycle);
    return store;
  } catch (error) {
    console.warn("seasonal store: sqlite unavailable: " + (error as Error).message);
    return null;
  }
}
