import type { PlayerSnapshotInput } from "@/lib/ban-db";
import { initializeSeasonalSchema } from "@/lib/seasonal/storage";
import { materializeRegularProgression } from "@/lib/regular-progression";
import { raidBucket } from "@/lib/seasonal/progression";
import { LEGACY_IDENTITY } from "@/types/seasonal";

export type SnapshotStatus = "baseline" | "progression" | "reset" | "schema_anomaly" | "duplicate" | "stale" | "banned";

export interface ProgressionDelta {
  elapsedMs: number;
  changes: Record<string, number>;
}

export interface CaptureSnapshotResult {
  inserted: boolean;
  status: SnapshotStatus;
  previousUpdatedAt: number | null;
  currentUpdatedAt: number;
  /** Null for the first snapshot, a duplicate/stale payload, or a wipe/reset. */
  delta: ProgressionDelta | null;
  resetFields: string[];
}

export interface ProgressionSnapshot {
  id: number;
  aid: number;
  upstreamUpdatedAt: number;
  capturedAt: number;
  seriesId: number;
  stats: PlayerSnapshotInput["stats"];
  achievementIds: string[];
}

export interface ProgressionCandidate {
  aid: number;
  fetchedAt: number;
  /** Null until the first historical snapshot has been recorded. */
  latestSnapshotAt: number | null;
  beforeUpdated: number | null;
}

export interface ProgressionStore {
  recordSnapshot(input: PlayerSnapshotInput): Promise<CaptureSnapshotResult>;
  latest(aid: number): Promise<ProgressionSnapshot | null>;
  history(aid: number): Promise<ProgressionSnapshot[]>;
  nextCandidate(excludeAids?: readonly number[]): Promise<ProgressionCandidate | null>;
}

const INSERT_SQL = `
INSERT INTO progression_snapshots (
  mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at, local_date,
  series_id, nickname, side, prestige, level,
  experience, hours, total_raids, pmc_raids, scav_raids, survived, deaths, pmc_deaths,
  total_kills, killed_pmc, run_through, longest_win_streak, achv_count, achievements, stats_json
) VALUES (${Array.from({ length: 27 }, () => "?").join(", ")})`;

const CUMULATIVE_FIELDS = [
  "experience", "hoursPlayed", "totalRaids", "pmcRaids", "scavRaids", "survivedRaids",
  "deaths", "pmcDeaths", "totalKills", "killedPmc", "runThrough", "achievementsCount",
] as const;

function validate(input: PlayerSnapshotInput) {
  if (!Number.isSafeInteger(input.aid) || input.aid <= 0) throw new Error("invalid aid");
  if (!Number.isFinite(input.upstreamUpdatedAt) || input.upstreamUpdatedAt <= 0) {
    throw new Error("upstreamUpdatedAt must be a positive timestamp");
  }
}

function args(input: PlayerSnapshotInput, seriesId: number): unknown[] {
  const s = input.stats;
  return [
    LEGACY_IDENTITY.mode, LEGACY_IDENTITY.cycleId, input.aid, input.upstreamUpdatedAt,
    input.upstreamUpdatedAt, input.capturedAt,
    new Date(input.upstreamUpdatedAt).toISOString().slice(0, 10), seriesId, s.nickname, s.side,
    s.prestige, s.level, s.experience, s.hoursPlayed, s.totalRaids, s.pmcRaids,
    s.scavRaids, s.survivedRaids, s.deaths, s.pmcDeaths, s.totalKills, s.killedPmc,
    s.runThrough, s.longestWinStreak, s.achievementsCount,
    JSON.stringify(input.achievementIds), JSON.stringify(s),
  ];
}

interface SnapshotRow {
  id: number;
  aid: number;
  upstream_updated_at: number;
  captured_at: number;
  series_id: number;
  achievements: string;
  stats_json: string;
  profile_updated_at?: number;
  local_date?: string;
  nickname?: string;
}

function toSnapshot(row: SnapshotRow | undefined): ProgressionSnapshot | null {
  if (!row) return null;
  return {
    id: Number(row.id),
    aid: Number(row.aid),
    upstreamUpdatedAt: Number(row.upstream_updated_at),
    capturedAt: Number(row.captured_at),
    seriesId: Number(row.series_id),
    stats: JSON.parse(row.stats_json) as PlayerSnapshotInput["stats"],
    achievementIds: JSON.parse(row.achievements) as string[],
  };
}

function compare(previous: ProgressionSnapshot, input: PlayerSnapshotInput) {
  const changes: Record<string, number> = {};
  const resetFields: string[] = [];
  for (const field of CUMULATIVE_FIELDS) {
    const before = Number(previous.stats[field] ?? 0);
    const after = Number(input.stats[field] ?? 0);
    changes[field] = after - before;
    if (after < before) resetFields.push(field);
  }
  return {
    changes,
    resetFields,
    delta: resetFields.length
      ? null
      : { elapsedMs: input.upstreamUpdatedAt - previous.upstreamUpdatedAt, changes },
  };
}

function dbPaths() {
  return {
    progression:
      process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db",
    players: process.env.SQLITE_PATH || "/data/players.db",
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sqliteDb: any = null;
let warned = false;

// Operator progression is SQLite-only for now. Cloudflare builds degrade to a
// null store unless the Node SQLite runtime is actually available.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getSqliteDb(): Promise<any | null> {
  if (sqliteDb) return sqliteDb;
  try {
    const files = dbPaths();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sqlite = (await import("node:sqlite" as string)) as any;
    const db = new sqlite.DatabaseSync(files.progression);
    initializeSeasonalSchema(db);
    db.prepare("ATTACH DATABASE ? AS players_db").run(files.players);
    try {
      db.prepare("SELECT aid FROM players_db.excluded_players LIMIT 0").get();
    } catch (error) {
      if (!/no such table/i.test((error as Error).message)) throw error;
      db.exec(`
        CREATE TABLE players_db.excluded_players (
          aid INTEGER PRIMARY KEY,
          reason TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
    }
    sqliteDb = db;
    return db;
  } catch (error) {
    if (!warned) {
      warned = true;
      console.warn("progression store: sqlite unavailable: " + (error as Error).message);
    }
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sqliteStore(db: any): ProgressionStore {
  return {
    async recordSnapshot(input) {
      validate(input);
      if (db.prepare("SELECT 1 FROM excluded_players WHERE aid = ?").get(input.aid)) {
        return {
          inserted: false, status: "banned", previousUpdatedAt: null,
          currentUpdatedAt: input.upstreamUpdatedAt, delta: null, resetFields: [],
        };
      }
      const previous = toSnapshot(db.prepare(
        "SELECT * FROM progression_snapshots WHERE mode = ? AND cycle_id = ? AND aid = ? ORDER BY upstream_updated_at DESC LIMIT 1"
      ).get(LEGACY_IDENTITY.mode, LEGACY_IDENTITY.cycleId, input.aid) as SnapshotRow | undefined);
      if (previous && input.upstreamUpdatedAt === previous.upstreamUpdatedAt) {
        return {
          inserted: false, status: "duplicate", previousUpdatedAt: previous.upstreamUpdatedAt,
          currentUpdatedAt: input.upstreamUpdatedAt, delta: null, resetFields: [],
        };
      }
      if (previous && input.upstreamUpdatedAt < previous.upstreamUpdatedAt) {
        return {
          inserted: false, status: "stale", previousUpdatedAt: previous.upstreamUpdatedAt,
          currentUpdatedAt: input.upstreamUpdatedAt, delta: null, resetFields: [],
        };
      }

      const comparison = previous ? compare(previous, input) : null;
      const isReset = Boolean(
        comparison?.resetFields.includes("experience") &&
        comparison.resetFields.includes("pmcRaids")
      );
      const isAnomaly = Boolean(comparison?.resetFields.length) && !isReset;
      const seriesId = previous ? previous.seriesId + (isReset ? 1 : 0) : 1;
      db.exec("SAVEPOINT record_regular_snapshot");
      try {
        db.prepare(INSERT_SQL).run(...args(input, seriesId));
        const targetBucket = raidBucket(input.stats.pmcRaids);
        materializeRegularProgression(db, input.aid, { targetBucket, refreshAggregates: false });
        db.exec("RELEASE record_regular_snapshot");
      } catch (error) {
        db.exec("ROLLBACK TO record_regular_snapshot");
        db.exec("RELEASE record_regular_snapshot");
        throw error;
      }
      return {
        inserted: true,
        status: previous ? (isReset ? "reset" : isAnomaly ? "schema_anomaly" : "progression") : "baseline",
        previousUpdatedAt: previous?.upstreamUpdatedAt ?? null,
        currentUpdatedAt: input.upstreamUpdatedAt,
        delta: comparison?.delta ?? null,
        resetFields: comparison?.resetFields ?? [],
      };
    },
    async latest(aid) {
      return toSnapshot(db.prepare(
        "SELECT * FROM progression_snapshots WHERE mode = ? AND cycle_id = ? AND aid = ? ORDER BY upstream_updated_at DESC LIMIT 1"
      ).get(LEGACY_IDENTITY.mode, LEGACY_IDENTITY.cycleId, aid) as SnapshotRow | undefined);
    },
    async history(aid) {
      const rows = db.prepare(
        "SELECT * FROM progression_snapshots WHERE mode = ? AND cycle_id = ? AND aid = ? ORDER BY upstream_updated_at ASC"
      ).all(LEGACY_IDENTITY.mode, LEGACY_IDENTITY.cycleId, aid) as SnapshotRow[];
      return rows.map((row) => toSnapshot(row)).filter((row): row is ProgressionSnapshot => row != null);
    },
    async nextCandidate(excludeAids = []) {
      const safeExcludes = [...new Set(excludeAids)].filter(
        (aid) => Number.isSafeInteger(aid) && aid > 0
      );
      const exclusion = safeExcludes.length
        ? `AND p.aid NOT IN (${safeExcludes.map(() => "?").join(", ")})`
        : "";
      const row = db.prepare(
        `SELECT p.aid, p.fetched_at,
                MAX(s.captured_at) AS latest_snapshot_at,
                MAX(s.upstream_updated_at) AS before_updated
           FROM players_db.players p
           LEFT JOIN progression_snapshots s ON s.aid = p.aid
            AND s.mode = 'regular' AND s.cycle_id = 'persistent'
          WHERE NOT EXISTS (
            SELECT 1 FROM players_db.excluded_players e WHERE e.aid = p.aid
          ) ${exclusion}
          GROUP BY p.aid, p.fetched_at
          ORDER BY CASE WHEN MAX(s.captured_at) IS NULL THEN 0 ELSE 1 END,
                   COALESCE(MAX(s.captured_at), p.fetched_at) ASC,
                   p.aid ASC
          LIMIT 1`
      ).get(...safeExcludes) as {
        aid: number; fetched_at: number; latest_snapshot_at: number | null; before_updated: number | null;
      } | undefined;
      if (!row) return null;
      return {
        aid: Number(row.aid),
        fetchedAt: Number(row.fetched_at),
        latestSnapshotAt: row.latest_snapshot_at == null ? null : Number(row.latest_snapshot_at),
        beforeUpdated: row.before_updated == null ? null : Number(row.before_updated),
      };
    },
  };
}

export async function getProgressionStore(): Promise<ProgressionStore | null> {
  const db = await getSqliteDb();
  return db ? sqliteStore(db) : null;
}

export async function captureSnapshot(input: PlayerSnapshotInput): Promise<CaptureSnapshotResult> {
  const store = await getProgressionStore();
  if (!store) throw new Error("progression store unavailable");
  return store.recordSnapshot(input);
}

export async function nextProgressionCandidate(
  excludeAids: readonly number[] = []
): Promise<ProgressionCandidate | null> {
  const store = await getProgressionStore();
  return store ? store.nextCandidate(excludeAids) : null;
}
