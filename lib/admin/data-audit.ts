import { randomUUID } from "node:crypto";

export const DATA_AUDIT_MODES = ["regular", "pve", "arena", "pvp-season"] as const;
export const DATA_AUDIT_DATASETS = ["index", "updated"] as const;
export type DataAuditMode = (typeof DATA_AUDIT_MODES)[number];
export type DataAuditDataset = (typeof DATA_AUDIT_DATASETS)[number];

const AUDIT_TIMEOUT_MS = 120_000;
export const AUDIT_LEASE_MS = 30 * 60_000;
const AUDIT_ENDPOINTS: Record<DataAuditMode, Record<DataAuditDataset, string>> = {
  regular: {
    index: "https://players.tarkov.dev/profile/index.json",
    updated: "https://players.tarkov.dev/profile/updated.json",
  },
  pve: {
    index: "https://players.tarkov.dev/pve/index.json",
    updated: "https://players.tarkov.dev/pve/updated.json",
  },
  arena: {
    index: "https://players.tarkov.dev/arena/index.json",
    updated: "https://players.tarkov.dev/arena/updated.json",
  },
  "pvp-season": {
    index: "https://players.tarkov.dev/pvp-season/index.json",
    updated: "https://players.tarkov.dev/pvp-season/updated.json",
  },
};

export type DataAuditDatasetResult = {
  mode: DataAuditMode;
  dataset: DataAuditDataset;
  status: "ok" | "unavailable";
  upstreamRecordCount: number | null;
  localMatchingCount: number | null;
  localCurrentCount: number | null;
  missingCount: number | null;
  staleCount: number | null;
  coveragePercent: number | null;
  lastCheckedAt: number | null;
  lastReceivedAt: number | null;
  lastLocalApplyAt: number | null;
  latestUpstreamUpdatedAt: number | null;
  error: string | null;
};

export type DataAuditSnapshot = {
  version: 1;
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

export type AuditLocalRow = {
  aid: number;
  nickname?: string | null;
  updatedAt?: number | null;
};

export type AuditLocalData = {
  available: boolean;
  rows: AuditLocalRow[];
  lastLocalApplyAt: number | null;
  error?: string;
};

type AuditRecordMap = Map<number, string | number>;

type SqliteDatabase = {
  exec(sql: string): void;
  close?(): void;
  prepare(sql: string): {
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
    run(...params: unknown[]): { changes?: number | bigint };
  };
};

type TarkovJsonRequest = (url: string | URL, init?: RequestInit) => Promise<Response>;

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asTimestamp(value: unknown): number | null {
  const numeric = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 1_000_000_000_000 ? Math.round(numeric * 1_000) : Math.round(numeric);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

function localTimestamp(value: unknown): number | null {
  const numeric = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : null;
}

function normalizeAid(value: unknown): number | null {
  const aid = Number(value);
  return Number.isSafeInteger(aid) && aid > 0 ? aid : null;
}

function parseRecords(payload: unknown, dataset: DataAuditDataset): AuditRecordMap {
  const object = asRecord(payload);
  if (!object) throw new Error("upstream_json_shape");
  const records: AuditRecordMap = new Map();
  for (const [rawAid, rawValue] of Object.entries(object)) {
    const aid = normalizeAid(rawAid);
    if (aid === null) throw new Error("upstream_invalid_aid");
    if (dataset === "index") {
      if (typeof rawValue !== "string") throw new Error("upstream_invalid_nickname");
      records.set(aid, rawValue);
    } else {
      const updatedAt = asTimestamp(rawValue);
      if (updatedAt === null) throw new Error("upstream_invalid_updated_at");
      records.set(aid, updatedAt);
    }
  }
  return records;
}

function emptyDataset(
  mode: DataAuditMode,
  dataset: DataAuditDataset,
  checkedAt: number,
  error: string,
  lastReceivedAt: number | null = null,
): DataAuditDatasetResult {
  return {
    mode,
    dataset,
    status: "unavailable",
    upstreamRecordCount: null,
    localMatchingCount: null,
    localCurrentCount: null,
    missingCount: null,
    staleCount: null,
    coveragePercent: null,
    lastCheckedAt: checkedAt,
    lastReceivedAt,
    lastLocalApplyAt: null,
    latestUpstreamUpdatedAt: null,
    error,
  };
}

function localNickname(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function latestUpdatedAt(dataset: DataAuditDataset, upstream: AuditRecordMap): number | null {
  if (dataset !== "updated" || upstream.size === 0) return null;
  let latest: number | null = null;
  for (const value of upstream.values()) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp)) continue;
    if (latest === null || timestamp > latest) latest = timestamp;
  }
  return latest;
}

/** Compare one validated upstream object with one local source. */
export function compareAuditRecords(
  mode: DataAuditMode,
  dataset: DataAuditDataset,
  upstream: AuditRecordMap,
  local: AuditLocalData,
  checkedAt: number,
  receivedAt: number,
): DataAuditDatasetResult {
  if (!local.available) {
    return {
      ...emptyDataset(mode, dataset, checkedAt, local.error ?? "local_storage_unavailable", receivedAt),
      upstreamRecordCount: upstream.size,
      latestUpstreamUpdatedAt: latestUpdatedAt(dataset, upstream),
      lastLocalApplyAt: local.lastLocalApplyAt,
    };
  }
  const localByAid = new Map(local.rows.map((row) => [row.aid, row]));
  let matching = 0;
  let current = 0;
  for (const [aid, expected] of upstream) {
    const row = localByAid.get(aid);
    if (!row) continue;
    matching += 1;
    if (dataset === "index") {
      if (localNickname(row.nickname) === localNickname(expected)) current += 1;
    } else {
      const localUpdatedAt = asTimestamp(row.updatedAt);
      if (localUpdatedAt !== null && localUpdatedAt >= Number(expected)) current += 1;
    }
  }
  const upstreamRecordCount = upstream.size;
  const coveragePercent = upstreamRecordCount === 0
    ? 100
    : Number(((current / upstreamRecordCount) * 100).toFixed(4));
  const latestUpstreamUpdatedAt = latestUpdatedAt(dataset, upstream);
  return {
    mode,
    dataset,
    status: "ok",
    upstreamRecordCount,
    localMatchingCount: matching,
    localCurrentCount: current,
    missingCount: upstreamRecordCount - matching,
    staleCount: matching - current,
    coveragePercent,
    lastCheckedAt: checkedAt,
    lastReceivedAt: receivedAt,
    lastLocalApplyAt: local.lastLocalApplyAt,
    latestUpstreamUpdatedAt,
    error: null,
  };
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

function maxLocalTimestamp(values: unknown[]): number | null {
  let latest: number | null = null;
  for (const value of values) {
    const timestamp = localTimestamp(value);
    if (timestamp !== null && (latest === null || timestamp > latest)) latest = timestamp;
  }
  return latest;
}

function metadataTimestamp(db: SqliteDatabase | null, table: string, key: string, cycleId?: string): number | null {
  if (!db || !tableExists(db, table)) return null;
  try {
    const row = cycleId === undefined
      ? db.prepare(`SELECT value FROM ${table} WHERE key = ?`).get(key)
      : db.prepare(`SELECT value FROM ${table} WHERE cycle_id = ? AND key = ?`).get(cycleId, key);
    return localTimestamp(row?.value);
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
        "SELECT cycle_id FROM player_profiles ORDER BY last_access_at DESC LIMIT 1",
      ).get();
      if (typeof row?.cycle_id === "string" && row.cycle_id) return row.cycle_id;
    } catch {
      return null;
    }
  }
  return null;
}

function localDataFor(
  mode: DataAuditMode,
  dataset: DataAuditDataset,
  playersDb: SqliteDatabase | null,
  progressionDb: SqliteDatabase | null,
): AuditLocalData {
  if (mode === "pvp-season") {
    const cycleId = chooseSeasonalCycle(progressionDb);
    if (!cycleId || !progressionDb) return { available: false, rows: [], lastLocalApplyAt: null, error: "seasonal_storage_unavailable" };
    if (dataset === "index") {
      const columns = tableColumns(progressionDb, "seasonal_player_index");
      if (!columns.has("cycle_id") || !columns.has("aid") || !columns.has("nickname")) {
        return { available: false, rows: [], lastLocalApplyAt: null, error: "seasonal_index_unavailable" };
      }
      try {
        const rows = progressionDb.prepare(
          "SELECT aid, nickname FROM seasonal_player_index WHERE cycle_id = ?",
        ).all(cycleId).map((row) => ({ aid: Number(row.aid), nickname: String(row.nickname) }));
        return {
          available: true,
          rows,
          lastLocalApplyAt: metadataTimestamp(progressionDb, "seasonal_player_index_meta", "synced_at", cycleId),
        };
      } catch {
        return { available: false, rows: [], lastLocalApplyAt: null, error: "seasonal_index_unavailable" };
      }
    }
    const columns = tableColumns(progressionDb, "player_profiles");
    if (!columns.has("mode") || !columns.has("cycle_id") || !columns.has("aid") || !columns.has("profile_updated_at")) {
      return { available: false, rows: [], lastLocalApplyAt: null, error: "seasonal_profiles_unavailable" };
    }
    try {
      const rows = progressionDb.prepare(
        "SELECT aid, profile_updated_at AS updated_at, last_access_at FROM player_profiles WHERE mode = 'seasonal' AND cycle_id = ?",
      ).all(cycleId).map((row) => ({ aid: Number(row.aid), updatedAt: Number(row.updated_at) }));
      const lastAccess = tableColumns(progressionDb, "player_profiles").has("last_access_at")
        ? maxLocalTimestamp(progressionDb.prepare(
          "SELECT last_access_at FROM player_profiles WHERE mode = 'seasonal' AND cycle_id = ?",
        ).all(cycleId).map((row) => row.last_access_at))
        : null;
      return { available: true, rows, lastLocalApplyAt: lastAccess };
    } catch {
      return { available: false, rows: [], lastLocalApplyAt: null, error: "seasonal_profiles_unavailable" };
    }
  }

  if (mode === "regular" && dataset === "index") {
    const columns = tableColumns(playersDb, "player_index");
    if (!playersDb || !columns.has("aid") || !columns.has("nickname")) {
      return { available: false, rows: [], lastLocalApplyAt: null, error: "player_index_unavailable" };
    }
    try {
      const rows = playersDb.prepare("SELECT aid, nickname FROM player_index")
        .all().map((row) => ({ aid: Number(row.aid), nickname: row.nickname == null ? null : String(row.nickname) }));
      return {
        available: true,
        rows,
        lastLocalApplyAt: metadataTimestamp(playersDb, "player_index_meta", "synced_at"),
      };
    } catch {
      return { available: false, rows: [], lastLocalApplyAt: null, error: "player_index_unavailable" };
    }
  }

  if ((mode === "pve" || mode === "arena") && dataset === "index") {
    const table = `${mode}_player_index`;
    const meta = `${mode}_player_index_meta`;
    const columns = tableColumns(playersDb, table);
    if (!playersDb || !columns.has("aid") || !columns.has("nickname")) {
      return { available: false, rows: [], lastLocalApplyAt: null, error: `${mode}_index_unavailable` };
    }
    try {
      const rows = playersDb.prepare(`SELECT aid, nickname FROM ${table} WHERE mode = ?`)
        .all(mode).map((row) => ({
          aid: Number(row.aid),
          nickname: row.nickname == null ? null : String(row.nickname),
        }));
      return {
        available: true,
        rows,
        lastLocalApplyAt: metadataTimestamp(playersDb, meta, "synced_at"),
      };
    } catch {
      return { available: false, rows: [], lastLocalApplyAt: null, error: `${mode}_index_unavailable` };
    }
  }

  const table = mode === "regular" ? "players" : "mode_players";
  const columns = tableColumns(playersDb, table);
  const required = dataset === "index" ? ["aid", "nickname"] : ["aid", "profile_updated_at"];
  if (!playersDb || required.some((column) => !columns.has(column))) {
    return { available: false, rows: [], lastLocalApplyAt: null, error: "player_storage_unavailable" };
  }
  try {
    const where = mode === "regular" ? "" : " WHERE mode = ?";
    const params = mode === "regular" ? [] : [mode];
    const rows = dataset === "index"
      ? playersDb.prepare(`SELECT aid, nickname FROM ${table}${where}`).all(...params)
        .map((row) => ({ aid: Number(row.aid), nickname: row.nickname == null ? null : String(row.nickname) }))
      : playersDb.prepare(`SELECT aid, profile_updated_at AS updated_at FROM ${table}${where}`).all(...params)
        .map((row) => ({ aid: Number(row.aid), updatedAt: Number(row.updated_at) }));
    const fetchedAt = columns.has("fetched_at")
      ? maxLocalTimestamp(playersDb.prepare(`SELECT fetched_at FROM ${table}${where}`).all(...params).map((row) => row.fetched_at))
      : null;
    return { available: true, rows, lastLocalApplyAt: fetchedAt };
  } catch {
    return { available: false, rows: [], lastLocalApplyAt: null, error: "player_storage_unavailable" };
  }
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

async function fetchRecords(
  url: string,
  request: TarkovJsonRequest,
  receivedAt: () => number,
): Promise<{ records: AuditRecordMap; receivedAt: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUDIT_TIMEOUT_MS);
  try {
    const response = await request(url, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`upstream_http_${response.status}`);
    const payload = await response.json();
    const received = receivedAt();
    return { records: parseRecords(payload, url.endsWith("/index.json") ? "index" : "updated"), receivedAt: received };
  } finally {
    clearTimeout(timer);
  }
}

async function defaultFetchTarkovJson(url: string | URL, init: RequestInit = {}): Promise<Response> {
  const { fetchTarkovJson } = await import("@/lib/tarkov-api");
  return fetchTarkovJson(url, init);
}

function parseStateRow(row: Record<string, unknown> | undefined, now = Date.now()): DataAuditState {
  if (!row) return { available: true, running: false, runId: null, startedAt: null, error: null, snapshot: null };
  let snapshot: DataAuditSnapshot | null = null;
  if (typeof row.result_json === "string") {
    try {
      const parsed = JSON.parse(row.result_json) as DataAuditSnapshot;
      if (parsed?.version === 1 && Array.isArray(parsed.datasets)) snapshot = parsed;
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
  request?: TarkovJsonRequest;
}): Promise<{ state: DataAuditState; started: boolean }> {
  const clock = options.now ?? Date.now;
  const runId = randomUUID();
  const startedAt = clock();
  const previousSnapshot = options.store.read().snapshot;
  const claimed = options.store.start(runId, startedAt);
  if (!claimed.started) return { state: claimed.state, started: false };
  const request = options.request ?? defaultFetchTarkovJson;
  let sources: Awaited<ReturnType<typeof openLocalDatabases>>;
  try {
    sources = await openLocalDatabases();
  } catch (error) {
    const finishedAt = clock();
    const datasets = DATA_AUDIT_MODES.flatMap((mode) => DATA_AUDIT_DATASETS.map((dataset) =>
      emptyDataset(mode, dataset, finishedAt, error instanceof Error ? error.message : "local_storage_unavailable"),
    ));
    const snapshot: DataAuditSnapshot = { version: 1, runId, status: "error", startedAt, finishedAt, datasets };
    options.store.finish(runId, snapshot, "local_storage_unavailable");
    return { state: options.store.read(), started: true };
  }
  const datasets: DataAuditDatasetResult[] = [];
  try {
    for (const mode of DATA_AUDIT_MODES) {
      for (const dataset of DATA_AUDIT_DATASETS) {
        const checkedAt = clock();
        let local: AuditLocalData = { available: false, rows: [], lastLocalApplyAt: null, error: "local_storage_unavailable" };
        const previous = previousSnapshot?.datasets.find((row) => row.mode === mode && row.dataset === dataset);
        try {
          local = localDataFor(mode, dataset, sources.players, sources.progression);
          const fetched = await fetchRecords(AUDIT_ENDPOINTS[mode][dataset], request, clock);
          const result = compareAuditRecords(mode, dataset, fetched.records, local, checkedAt, fetched.receivedAt);
          if (result.status === "unavailable") {
            result.lastReceivedAt ??= previous?.lastReceivedAt ?? null;
            result.lastLocalApplyAt ??= previous?.lastLocalApplyAt ?? null;
          }
          datasets.push(result);
        } catch (error) {
          const result = emptyDataset(
            mode,
            dataset,
            checkedAt,
            error instanceof Error ? error.message : "audit_unavailable",
            previous?.lastReceivedAt ?? null,
          );
          result.lastLocalApplyAt = local.lastLocalApplyAt ?? previous?.lastLocalApplyAt ?? null;
          result.latestUpstreamUpdatedAt = previous?.latestUpstreamUpdatedAt ?? null;
          datasets.push(result);
        }
      }
    }
  } finally {
    sources.close();
  }
  const finishedAt = clock();
  const status = datasets.every((dataset) => dataset.status === "ok")
    ? "success"
    : datasets.some((dataset) => dataset.status === "ok") ? "partial" : "error";
  const snapshot: DataAuditSnapshot = { version: 1, runId, status, startedAt, finishedAt, datasets };
  options.store.finish(runId, snapshot, status === "error" ? "audit_unavailable" : null);
  return { state: options.store.read(), started: true };
}

export type { DataAuditStore };
