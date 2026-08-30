export const AVERAGE_PUBLICATION_DEBOUNCE_MS = 5 * 60_000;
export const AVERAGE_PUBLICATION_MIN_INTERVAL_MS = 15 * 60_000;
export const AVERAGE_PUBLICATION_FORCE_INTERVAL_MS = 6 * 60 * 60_000;
// A healthy publication remains current until the six-hour safety refresh has
// had enough time to finish even for the slow Seasonal scope.
export const AVERAGE_PUBLICATION_STALE_MS = AVERAGE_PUBLICATION_FORCE_INTERVAL_MS + 30 * 60_000;

export type AveragePublicationScope = "regular" | "pve" | "arena" | `seasonal:${string}`;

export interface AveragePublication<T = unknown> {
  scope: AveragePublicationScope;
  variant: string;
  generation: number;
  generatedAt: number;
  stale: boolean;
  payload: T;
}

export interface AveragePublicationState {
  scope: AveragePublicationScope;
  generation: number | null;
  generatedAt: number | null;
  dirtyAt: number | null;
  lastStartedAt: number | null;
  lastCompletedAt: number | null;
  lastDurationMs: number | null;
  lastError: string | null;
  variants: number;
  status: "warming" | "dirty" | "processing" | "ready" | "stale" | "error";
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS average_publication_current (
  scope TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  generated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS average_publication_payloads (
  scope TEXT NOT NULL,
  generation INTEGER NOT NULL,
  variant TEXT NOT NULL,
  generated_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (scope, generation, variant)
);
CREATE INDEX IF NOT EXISTS idx_average_publication_payload_lookup
  ON average_publication_payloads(scope, variant, generation);
CREATE TABLE IF NOT EXISTS average_publication_state (
  scope TEXT PRIMARY KEY,
  dirty_at INTEGER,
  last_started_at INTEGER,
  last_completed_at INTEGER,
  last_duration_ms INTEGER,
  last_error TEXT
);
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let database: any = null;
let databasePath: string | null = null;

export function averagePublicationPath(): string {
  return process.env.AVERAGE_PUBLICATION_SQLITE_PATH || "/data/average-publications.db";
}

export function averagePublicationsEnabled(): boolean {
  if (process.env.AVERAGE_PUBLICATIONS_ENABLED === "false") return false;
  return Boolean(process.env.SQLITE_PATH) &&
    (process.env.AVERAGE_PUBLICATIONS_ENABLED === "true" || process.env.NODE_ENV === "production");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function openDatabase(): Promise<any> {
  const path = averagePublicationPath();
  if (database && databasePath === path) return database;
  const sqlite = await import("node:sqlite" as string);
  database = new sqlite.DatabaseSync(path);
  databasePath = path;
  database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  database.exec(SCHEMA);
  return database;
}

function nullableNumber(value: unknown): number | null {
  return value == null ? null : Number(value);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, 500);
}

export function standardAverageVariant(statistic: "trimmed_mean" | "median", period: "all" | "90d"): string {
  return `standard:${statistic}:${period}`;
}

export function standardArenaVariant(mode: string, statistic: "trimmed_mean" | "median"): string {
  return `standard:${mode}:${statistic}`;
}

export function seasonalPublicationScope(cycleId: string): AveragePublicationScope {
  return `seasonal:${cycleId}`;
}

export async function readAveragePublication<T>(
  scope: AveragePublicationScope,
  variant: string,
  now = Date.now(),
): Promise<AveragePublication<T> | null> {
  if (!averagePublicationsEnabled()) return null;
  try {
    const db = await openDatabase();
    const row = db.prepare(`SELECT p.generation, p.generated_at, p.payload_json, s.last_error
      FROM average_publication_current c
      JOIN average_publication_payloads p ON p.scope = c.scope AND p.generation = c.generation
      LEFT JOIN average_publication_state s ON s.scope = c.scope
      WHERE c.scope = ? AND p.variant = ?`).get(scope, variant) as Record<string, unknown> | undefined;
    if (!row) return null;
    const generation = Number(row.generation);
    const generatedAt = Number(row.generated_at);
    const payload = JSON.parse(String(row.payload_json)) as T;
    if (!Number.isFinite(generation) || !Number.isFinite(generatedAt) || payload == null) return null;
    return {
      scope,
      variant,
      generation,
      generatedAt,
      stale: now - generatedAt > AVERAGE_PUBLICATION_STALE_MS || row.last_error != null,
      payload,
    };
  } catch (error) {
    console.warn("average publication read failed: " + safeError(error));
    return null;
  }
}

export async function markAveragePublicationDirty(
  scope: AveragePublicationScope,
  dirtyAt = Date.now(),
): Promise<void> {
  if (!averagePublicationsEnabled()) return;
  try {
    const db = await openDatabase();
    db.prepare(`INSERT INTO average_publication_state (scope, dirty_at) VALUES (?, ?)
      ON CONFLICT(scope) DO UPDATE SET dirty_at = MAX(COALESCE(average_publication_state.dirty_at, 0), excluded.dirty_at)`)
      .run(scope, dirtyAt);
  } catch (error) {
    console.warn("average publication dirty marker failed: " + safeError(error));
  }
}

export async function beginAveragePublication(scope: AveragePublicationScope, startedAt = Date.now()): Promise<void> {
  const db = await openDatabase();
  db.prepare(`INSERT INTO average_publication_state (scope, last_started_at, last_error) VALUES (?, ?, NULL)
    ON CONFLICT(scope) DO UPDATE SET last_started_at = excluded.last_started_at, last_error = NULL`)
    .run(scope, startedAt);
}

export async function failAveragePublication(scope: AveragePublicationScope, error: unknown): Promise<void> {
  const db = await openDatabase();
  db.prepare(`INSERT INTO average_publication_state (scope, last_error) VALUES (?, ?)
    ON CONFLICT(scope) DO UPDATE SET last_error = excluded.last_error`).run(scope, safeError(error));
}

export async function publishAverageScope(
  scope: AveragePublicationScope,
  payloads: ReadonlyMap<string, unknown>,
  startedAt: number,
  generatedAt = Date.now(),
): Promise<{ generation: number; generatedAt: number; variants: number }> {
  if (payloads.size === 0) throw new Error(`cannot publish empty average scope ${scope}`);
  const serialized = [...payloads].map(([variant, payload]) => [variant, JSON.stringify(payload)] as const);
  const db = await openDatabase();
  const previous = db.prepare("SELECT MAX(generation) AS generation FROM average_publication_payloads WHERE scope = ?")
    .get(scope) as { generation?: number | null } | undefined;
  const generation = Math.max(generatedAt, Number(previous?.generation ?? 0) + 1);
  db.exec("BEGIN IMMEDIATE");
  try {
    const insert = db.prepare(`INSERT INTO average_publication_payloads
      (scope, generation, variant, generated_at, payload_json) VALUES (?, ?, ?, ?, ?)`);
    for (const [variant, payloadJson] of serialized) {
      insert.run(scope, generation, variant, generatedAt, payloadJson);
    }
    db.prepare(`INSERT INTO average_publication_current (scope, generation, generated_at) VALUES (?, ?, ?)
      ON CONFLICT(scope) DO UPDATE SET generation = excluded.generation, generated_at = excluded.generated_at`)
      .run(scope, generation, generatedAt);
    db.prepare(`INSERT INTO average_publication_state
      (scope, dirty_at, last_completed_at, last_duration_ms, last_error) VALUES (?, NULL, ?, ?, NULL)
      ON CONFLICT(scope) DO UPDATE SET
        dirty_at = CASE WHEN average_publication_state.dirty_at IS NULL OR average_publication_state.dirty_at <= ?
          THEN NULL ELSE average_publication_state.dirty_at END,
        last_completed_at = excluded.last_completed_at,
        last_duration_ms = excluded.last_duration_ms, last_error = NULL`)
      .run(scope, generatedAt, Math.max(0, generatedAt - startedAt), startedAt);
    db.prepare(`DELETE FROM average_publication_payloads WHERE scope = ? AND generation NOT IN
      (SELECT generation FROM average_publication_payloads WHERE scope = ? GROUP BY generation ORDER BY generation DESC LIMIT 2)`)
      .run(scope, scope);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { generation, generatedAt, variants: payloads.size };
}

export async function getAveragePublicationStates(now = Date.now()): Promise<AveragePublicationState[]> {
  if (!averagePublicationsEnabled()) return [];
  try {
    const db = await openDatabase();
    const rows = db.prepare(`SELECT s.scope, c.generation, c.generated_at, s.dirty_at,
        s.last_started_at, s.last_completed_at, s.last_duration_ms, s.last_error,
        COUNT(p.variant) AS variants
      FROM average_publication_state s
      LEFT JOIN average_publication_current c ON c.scope = s.scope
      LEFT JOIN average_publication_payloads p ON p.scope = c.scope AND p.generation = c.generation
      GROUP BY s.scope ORDER BY s.scope`).all() as Record<string, unknown>[];
    return rows.map((row) => {
      const generatedAt = nullableNumber(row.generated_at);
      const dirtyAt = nullableNumber(row.dirty_at);
      const lastStartedAt = nullableNumber(row.last_started_at);
      const lastCompletedAt = nullableNumber(row.last_completed_at);
      const lastError = row.last_error == null ? null : String(row.last_error);
      const processing = lastStartedAt != null && (lastCompletedAt == null || lastStartedAt > lastCompletedAt);
      return {
        scope: String(row.scope) as AveragePublicationScope,
        generation: nullableNumber(row.generation),
        generatedAt,
        dirtyAt,
        lastStartedAt,
        lastCompletedAt,
        lastDurationMs: nullableNumber(row.last_duration_ms),
        lastError,
        variants: Number(row.variants ?? 0),
        status: lastError ? "error" : processing ? "processing" : generatedAt == null ? "warming"
          : dirtyAt != null ? "dirty" : now - generatedAt > AVERAGE_PUBLICATION_STALE_MS ? "stale" : "ready",
      };
    });
  } catch (error) {
    console.warn("average publication state read failed: " + safeError(error));
    return [];
  }
}

export function averagePublicationDue(state: AveragePublicationState | undefined, now = Date.now()): boolean {
  if (!state) return true;
  if (!state.generatedAt) {
    return state.lastStartedAt == null || now - state.lastStartedAt >= AVERAGE_PUBLICATION_MIN_INTERVAL_MS;
  }
  if (now - state.generatedAt >= AVERAGE_PUBLICATION_FORCE_INTERVAL_MS) return true;
  if (state.dirtyAt == null || now - state.dirtyAt < AVERAGE_PUBLICATION_DEBOUNCE_MS) return false;
  return state.lastCompletedAt == null || now - state.lastCompletedAt >= AVERAGE_PUBLICATION_MIN_INTERVAL_MS;
}

export function resetAveragePublicationForTests(): void {
  database?.close?.();
  database = null;
  databasePath = null;
}
