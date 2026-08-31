import { randomUUID } from "node:crypto";

export const DATA_AUDIT_MODES = ["regular", "pve", "arena", "pvp-season"] as const;
export const DATA_AUDIT_DATASETS = ["index", "updated"] as const;
export type DataAuditMode = (typeof DATA_AUDIT_MODES)[number];
export type DataAuditDataset = (typeof DATA_AUDIT_DATASETS)[number];

export const AUDIT_LEASE_MS = 30 * 60_000;

export type DataAuditDatasetResult = {
  mode: DataAuditMode;
  dataset: DataAuditDataset;
  status: "ok" | "unavailable";
  upstreamRecordCount: number | null;
  localRecordCount: number | null;
  differenceCount: number | null;
  coveragePercent: number | null;
  lastCheckedAt: number | null;
  lastReceivedAt: number | null;
  lastLocalApplyAt: number | null;
  latestUpstreamUpdatedAt: number | null;
  error: string | null;
};

export type DataAuditSnapshot = {
  version: 2;
  runId: string;
  status: "success" | "partial" | "error";
  startedAt: number;
  finishedAt: number;
  datasets: DataAuditDatasetResult[];
};

export type DataAuditState = {
  available: boolean;
  running: boolean;
  runId: string | null;
  startedAt: number | null;
  error: string | null;
  snapshot: DataAuditSnapshot | null;
};

type SqliteDatabase = {
  exec(sql: string): void;
  close?(): void;
  prepare(sql: string): {
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
    run(...params: unknown[]): { changes?: number | bigint };
  };
};

type DataAuditStore = {
  read(now?: number): DataAuditState;
  start(runId: string, now: number): { started: true } | { started: false; state: DataAuditState };
  finish(runId: string, snapshot: DataAuditSnapshot, error?: string | null): void;
};

export const DATA_AUDIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS admin_data_audit_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial', 'error')),
  run_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  result_json TEXT,
  error TEXT
);
`;

function localTimestamp(value: unknown): number | null {
  const numeric = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : null;
}

function countValue(value: unknown): number | null {
  const numeric = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

function tableExists(db: SqliteDatabase | null, table: string): boolean {
  if (!db) return false;
  try {
    return Boolean(db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table));
  } catch {
    return false;
  }
}

function tableColumns(db: SqliteDatabase | null, table: string): Set<string> {
  if (!db || !tableExists(db, table)) return new Set();
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name)));
  } catch {
    return new Set();
  }
}

function metadataValue(
  db: SqliteDatabase | null,
  table: string,
  key: string,
  cycleId?: string,
): unknown {
  if (!db || !tableExists(db, table)) return null;
  try {
    return cycleId === undefined
      ? db.prepare(`SELECT value FROM ${table} WHERE key = ?`).get(key)?.value ?? null
      : db.prepare(`SELECT value FROM ${table} WHERE cycle_id = ? AND key = ?`).get(cycleId, key)?.value ?? null;
  } catch {
    return null;
  }
}

function metadataNumber(
  db: SqliteDatabase | null,
  table: string,
  key: string,
  cycleId?: string,
): number | null {
  return countValue(metadataValue(db, table, key, cycleId));
}

function metadataTimestamp(
  db: SqliteDatabase | null,
  table: string,
  key: string,
  cycleId?: string,
): number | null {
  return localTimestamp(metadataValue(db, table, key, cycleId));
}

function summaryNumber(
  db: SqliteDatabase | null,
  table: string,
  key: string,
  cycleId?: string,
): number | null {
  const raw = metadataValue(db, table, "last_summary", cycleId);
  if (typeof raw !== "string") return null;
  try {
    const summary = JSON.parse(raw) as Record<string, unknown>;
    return countValue(summary[key]);
  } catch {
    return null;
  }
}

function queryCount(db: SqliteDatabase | null, sql: string, ...params: unknown[]): number | null {
  if (!db) return null;
  try {
    return countValue(db.prepare(sql).get(...params)?.count);
  } catch {
    return null;
  }
}

function queryTimestamp(db: SqliteDatabase | null, sql: string, ...params: unknown[]): number | null {
  if (!db) return null;
  try {
    return localTimestamp(db.prepare(sql).get(...params)?.timestamp);
  } catch {
    return null;
  }
}

function chooseSeasonalCycle(db: SqliteDatabase | null): string | null {
  const configured = process.env.SEASONAL_CYCLE_ID?.trim();
  if (configured) return configured;
  if (db && tableExists(db, "season_cycles")) {
    try {
      const row = db.prepare(
        "SELECT cycle_id FROM season_cycles ORDER BY enabled DESC, starts_at DESC LIMIT 1",
      ).get();
      if (typeof row?.cycle_id === "string" && row.cycle_id) return row.cycle_id;
    } catch {
      // Continue to the profile table fallback.
    }
  }
  if (db && tableExists(db, "player_profiles")) {
    try {
      const row = db.prepare(
        "SELECT cycle_id FROM player_profiles WHERE mode = 'seasonal' ORDER BY last_access_at DESC LIMIT 1",
      ).get();
      if (typeof row?.cycle_id === "string" && row.cycle_id) return row.cycle_id;
    } catch {
      return null;
    }
  }
  return null;
}

export function compareAuditCounts(
  mode: DataAuditMode,
  dataset: DataAuditDataset,
  upstreamRecordCount: number | null,
  localRecordCount: number | null,
  checkedAt: number,
  metadata: {
    lastReceivedAt?: number | null;
    lastLocalApplyAt?: number | null;
    latestUpstreamUpdatedAt?: number | null;
    error?: string;
  } = {},
): DataAuditDatasetResult {
  const available = upstreamRecordCount !== null && localRecordCount !== null;
  const differenceCount = available ? localRecordCount - upstreamRecordCount : null;
  const coveragePercent = !available
    ? null
    : upstreamRecordCount === 0
      ? (localRecordCount === 0 ? 100 : 0)
      : Number(((localRecordCount / upstreamRecordCount) * 100).toFixed(4));
  return {
    mode,
    dataset,
    status: available ? "ok" : "unavailable",
    upstreamRecordCount,
    localRecordCount,
    differenceCount,
    coveragePercent,
    lastCheckedAt: checkedAt,
    lastReceivedAt: metadata.lastReceivedAt ?? null,
    lastLocalApplyAt: metadata.lastLocalApplyAt ?? null,
    latestUpstreamUpdatedAt: metadata.latestUpstreamUpdatedAt ?? null,
    error: available ? null : metadata.error ?? "sync_metadata_unavailable",
  };
}

function indexAudit(
  mode: DataAuditMode,
  playersDb: SqliteDatabase | null,
  progressionDb: SqliteDatabase | null,
  cycleId: string | null,
  checkedAt: number,
): DataAuditDatasetResult {
  let db = playersDb;
  let table = "player_index";
  let meta = "player_index_meta";
  let where = "";
  let params: unknown[] = [];
  let metaCycle: string | undefined;

  if (mode === "pve" || mode === "arena") {
    table = `${mode}_player_index`;
    meta = `${mode}_player_index_meta`;
    where = " WHERE mode = ?";
    params = [mode];
  } else if (mode === "pvp-season") {
    db = progressionDb;
    table = "seasonal_player_index";
    meta = "seasonal_player_index_meta";
    if (!cycleId) {
      return compareAuditCounts(mode, "index", null, null, checkedAt, { error: "seasonal_cycle_unavailable" });
    }
    where = " WHERE cycle_id = ?";
    params = [cycleId];
    metaCycle = cycleId;
  }

  const columns = tableColumns(db, table);
  const localRecordCount = columns.has("aid")
    ? queryCount(db, `SELECT COUNT(*) AS count FROM ${table}${where}`, ...params)
    : null;
  const upstreamRecordCount = metadataNumber(db, meta, "source_rows", metaCycle)
    ?? metadataNumber(db, meta, "row_count", metaCycle);
  const lastLocalApplyAt = metadataTimestamp(db, meta, "synced_at", metaCycle);
  const lastReceivedAt = metadataTimestamp(db, meta, "last_poll_at", metaCycle) ?? lastLocalApplyAt;
  return compareAuditCounts(mode, "index", upstreamRecordCount, localRecordCount, checkedAt, {
    lastReceivedAt,
    lastLocalApplyAt,
  });
}

function updatedAudit(
  mode: DataAuditMode,
  playersDb: SqliteDatabase | null,
  progressionDb: SqliteDatabase | null,
  cycleId: string | null,
  checkedAt: number,
): DataAuditDatasetResult {
  let db = playersDb;
  let table = "players";
  let meta = "regular_profile_sync_meta";
  let where = "";
  let params: unknown[] = [];
  let applyColumn = "fetched_at";
  let metaCycle: string | undefined;

  if (mode === "pve" || mode === "arena") {
    table = "mode_players";
    meta = `${mode}_profile_sync_meta`;
    where = " WHERE mode = ?";
    params = [mode];
  } else if (mode === "pvp-season") {
    db = progressionDb;
    table = "player_profiles";
    meta = "seasonal_profile_sync_meta";
    applyColumn = "last_access_at";
    if (!cycleId) {
      return compareAuditCounts(mode, "updated", null, null, checkedAt, { error: "seasonal_cycle_unavailable" });
    }
    where = " WHERE mode = 'seasonal' AND cycle_id = ?";
    params = [cycleId];
    metaCycle = cycleId;
  }

  const columns = tableColumns(db, table);
  const localRecordCount = columns.has("aid")
    ? queryCount(db, `SELECT COUNT(*) AS count FROM ${table}${where}`, ...params)
    : null;
  const lastLocalApplyAt = columns.has(applyColumn)
    ? queryTimestamp(db, `SELECT MAX(${applyColumn}) AS timestamp FROM ${table}${where}`, ...params)
    : null;
  return compareAuditCounts(
    mode,
    "updated",
    summaryNumber(db, meta, "sourceEntries", metaCycle),
    localRecordCount,
    checkedAt,
    {
      lastReceivedAt: metadataTimestamp(db, meta, "last_poll_at", metaCycle),
      lastLocalApplyAt,
      latestUpstreamUpdatedAt: metadataTimestamp(db, meta, "last_feed_max_updated_at", metaCycle),
    },
  );
}

async function openLocalDatabases(): Promise<{ players: SqliteDatabase | null; progression: SqliteDatabase | null; close(): void }> {
  const fs = await import("node:fs");
  const sqlite = await import("node:sqlite" as string) as { DatabaseSync: new (path: string) => SqliteDatabase };
  const playersPath = process.env.SQLITE_PATH || "/data/players.db";
  const progressionPath = process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db";
  const open = (file: string): SqliteDatabase | null => {
    if (file !== ":memory:" && !fs.existsSync(file)) return null;
    try {
      const db = new sqlite.DatabaseSync(file);
      db.exec("PRAGMA busy_timeout = 30000");
      return db;
    } catch {
      return null;
    }
  };
  const players = open(playersPath);
  const progression = open(progressionPath);
  return {
    players,
    progression,
    close() {
      try { players?.close?.(); } catch {}
      try { progression?.close?.(); } catch {}
    },
  };
}

function parseStateRow(row: Record<string, unknown> | undefined, now = Date.now()): DataAuditState {
  if (!row) return { available: true, running: false, runId: null, startedAt: null, error: null, snapshot: null };
  let snapshot: DataAuditSnapshot | null = null;
  if (typeof row.result_json === "string") {
    try {
      const parsed = JSON.parse(row.result_json) as DataAuditSnapshot;
      if (parsed?.version === 2 && Array.isArray(parsed.datasets)) snapshot = parsed;
    } catch {
      snapshot = null;
    }
  }
  const startedAt = localTimestamp(row.started_at);
  const running = row.status === "running"
    && startedAt !== null
    && startedAt > now - AUDIT_LEASE_MS;
  return {
    available: true,
    running,
    runId: running && typeof row.run_id === "string" ? row.run_id : null,
    startedAt,
    error: typeof row.error === "string" ? row.error : null,
    snapshot,
  };
}

export function createDataAuditStore(db: SqliteDatabase): DataAuditStore {
  db.exec(DATA_AUDIT_SCHEMA);
  return {
    read(now = Date.now()) {
      return parseStateRow(db.prepare("SELECT * FROM admin_data_audit_state WHERE id = 1").get(), now);
    },
    start(runId, now) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = db.prepare("SELECT * FROM admin_data_audit_state WHERE id = 1").get();
        const existingStartedAt = localTimestamp(existing?.started_at);
        if (existing?.status === "running" && existingStartedAt !== null && existingStartedAt > now - AUDIT_LEASE_MS) {
          db.exec("ROLLBACK");
          return { started: false, state: parseStateRow(existing, now) };
        }
        db.prepare(`INSERT INTO admin_data_audit_state
          (id, status, run_id, started_at, finished_at, result_json, error)
          VALUES (1, 'running', ?, ?, NULL, ?, NULL)
          ON CONFLICT(id) DO UPDATE SET status = 'running', run_id = excluded.run_id,
            started_at = excluded.started_at, finished_at = NULL, error = NULL`).run(
          runId, now, existing?.result_json ?? null,
        );
        db.exec("COMMIT");
        return { started: true };
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch {}
        throw error;
      }
    },
    finish(runId, snapshot, error = null) {
      const result = db.prepare(`UPDATE admin_data_audit_state
        SET status = ?, finished_at = ?, result_json = ?, error = ?
        WHERE id = 1 AND run_id = ? AND status = 'running'`).run(
        snapshot.status, snapshot.finishedAt, JSON.stringify(snapshot), error, runId,
      );
      if (Number(result.changes ?? 0) !== 1) throw new Error("audit_lease_lost");
    },
  };
}

let auditStorePromise: Promise<DataAuditStore | null> | null = null;

export async function getDataAuditStore(): Promise<DataAuditStore | null> {
  if (auditStorePromise) return auditStorePromise;
  auditStorePromise = (async () => {
    try {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const file = process.env.ADMIN_ANALYTICS_SQLITE_PATH || "/data/admin-analytics.db";
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const sqlite = await import("node:sqlite" as string) as { DatabaseSync: new (path: string) => SqliteDatabase };
      const db = new sqlite.DatabaseSync(file);
      db.exec("PRAGMA busy_timeout = 30000");
      return createDataAuditStore(db);
    } catch (error) {
      console.warn("admin data audit unavailable: " + (error instanceof Error ? error.message : String(error)));
      return null;
    }
  })();
  return auditStorePromise;
}

export async function runDataAudit(options: {
  store: DataAuditStore;
  now?: () => number;
}): Promise<{ state: DataAuditState; started: boolean }> {
  const clock = options.now ?? Date.now;
  const runId = randomUUID();
  const startedAt = clock();
  const claimed = options.store.start(runId, startedAt);
  if (!claimed.started) return { state: claimed.state, started: false };

  let sources: Awaited<ReturnType<typeof openLocalDatabases>>;
  try {
    sources = await openLocalDatabases();
  } catch (error) {
    const finishedAt = clock();
    const datasets = DATA_AUDIT_MODES.flatMap((mode) => DATA_AUDIT_DATASETS.map((dataset) =>
      compareAuditCounts(mode, dataset, null, null, finishedAt, {
        error: error instanceof Error ? error.message : "local_storage_unavailable",
      }),
    ));
    const snapshot: DataAuditSnapshot = { version: 2, runId, status: "error", startedAt, finishedAt, datasets };
    options.store.finish(runId, snapshot, "local_storage_unavailable");
    return { state: options.store.read(), started: true };
  }

  const datasets: DataAuditDatasetResult[] = [];
  try {
    const cycleId = chooseSeasonalCycle(sources.progression);
    for (const mode of DATA_AUDIT_MODES) {
      datasets.push(indexAudit(mode, sources.players, sources.progression, cycleId, clock()));
      datasets.push(updatedAudit(mode, sources.players, sources.progression, cycleId, clock()));
    }
  } finally {
    sources.close();
  }

  const finishedAt = clock();
  const status = datasets.every((dataset) => dataset.status === "ok")
    ? "success"
    : datasets.some((dataset) => dataset.status === "ok") ? "partial" : "error";
  const snapshot: DataAuditSnapshot = { version: 2, runId, status, startedAt, finishedAt, datasets };
  options.store.finish(runId, snapshot, status === "error" ? "sync_metadata_unavailable" : null);
  return { state: options.store.read(), started: true };
}

export type { DataAuditStore };
