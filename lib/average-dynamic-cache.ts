export const DYNAMIC_AVERAGE_TTL_MS = 5 * 60_000;
export const DYNAMIC_AVERAGE_STALE_MS = 30 * 60_000;
export const DYNAMIC_AVERAGE_MAX_KEYS = 512;
export const DYNAMIC_AVERAGE_PERSISTENT_MAX_ROWS = 2000;
export const DYNAMIC_AVERAGE_RETRY_AFTER_SECONDS = 5;

const TTL_MS = DYNAMIC_AVERAGE_TTL_MS;
const MAX_KEYS = DYNAMIC_AVERAGE_MAX_KEYS;

export function dynamicAverageBudgetMs(): number {
  const raw = Number(process.env.DYNAMIC_AVERAGE_BUDGET_MS);
  if (Number.isFinite(raw) && raw > 0) return Math.min(10_000, Math.floor(raw));
  return 900;
}

export class DynamicAverageWarmingError extends Error {
  readonly retryAfter: number;
  constructor(retryAfter = DYNAMIC_AVERAGE_RETRY_AFTER_SECONDS) {
    super("Dynamic average is warming");
    this.name = "DynamicAverageWarmingError";
    this.retryAfter = retryAfter;
  }
}

export function isDynamicAverageWarmingError(error: unknown): error is DynamicAverageWarmingError {
  return error instanceof DynamicAverageWarmingError;
}

export interface DynamicAverageOptions {
  budgetMs?: number;
  staleMs?: number;
  persistent?: boolean;
}

export type DynamicAverageResult<T> = { value: T; cache: "hit" | "miss"; stale: boolean };

type Entry<T> = {
  promise: Promise<T>;
  expiresAt: number;
  staleAt: number;
  value?: T;
  hasValue: boolean;
  settled: boolean;
};
const entries = new Map<string, Entry<unknown>>();
const coldInflight = new Map<string, Promise<DynamicAverageResult<unknown>>>();

function prune(now: number): void {
  for (const [key, entry] of entries) {
    if (entry.staleAt <= now && entry.settled) entries.delete(key);
  }
  while (entries.size >= MAX_KEYS) entries.delete(entries.keys().next().value!);
}

function withBudget<T>(promise: Promise<T>, budgetMs: number): Promise<T> {
  if (!Number.isFinite(budgetMs) || budgetMs === Infinity || budgetMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DynamicAverageWarmingError()), budgetMs);
    if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
      (timer as unknown as { unref: () => void }).unref();
    }
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let persistentDb: any = null;
let persistentPath: string | null = null;

function persistentCachePath(): string | null {
  const configured = process.env.DYNAMIC_AVERAGE_SQLITE_PATH ?? process.env.AVERAGE_PUBLICATION_SQLITE_PATH;
  return configured && configured.trim() !== "" ? configured : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function openPersistentCache(): Promise<any | null> {
  const path = persistentCachePath();
  if (!path) return null;
  if (persistentDb && persistentPath === path) return persistentDb;
  try {
    const sqlite = (await import("node:sqlite" as string)) as unknown as {
      DatabaseSync: new (path: string) => unknown;
    };
    const db = new sqlite.DatabaseSync(path) as unknown as {
      exec: (sql: string) => void;
      prepare: (sql: string) => unknown;
    };
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    db.exec(`CREATE TABLE IF NOT EXISTS dynamic_average_cache (
      key TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      generated_at INTEGER NOT NULL
    );`);
    persistentDb = db;
    persistentPath = path;
    return db;
  } catch {
    return null;
  }
}

async function readPersistentCache<T>(key: string, now: number, staleMs: number): Promise<{ value: T; stale: boolean } | null> {
  const db = await openPersistentCache();
  if (!db) return null;
  try {
    const row = (
      db.prepare("SELECT payload_json, generated_at FROM dynamic_average_cache WHERE key = ?") as {
        get: (key: string) => { payload_json?: unknown; generated_at?: unknown } | undefined;
      }
    ).get(key);
    if (!row || typeof row.payload_json !== "string") return null;
    const generatedAt = Number(row.generated_at);
    if (!Number.isFinite(generatedAt)) return null;
    const age = now - generatedAt;
    if (age < 0 || age > TTL_MS + staleMs) return null;
    const value = JSON.parse(row.payload_json) as T;
    if (value == null) return null;
    return { value, stale: age > TTL_MS };
  } catch {
    return null;
  }
}

async function writePersistentCache(key: string, value: unknown): Promise<void> {
  const db = await openPersistentCache();
  if (!db) return;
  try {
    const now = Date.now();
    const payload = JSON.stringify(value);
    if (payload.length > 4_000_000) return;
    (
      db.prepare(`INSERT INTO dynamic_average_cache (key, payload_json, generated_at)
        VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET payload_json = excluded.payload_json, generated_at = excluded.generated_at`) as {
        run: (...args: unknown[]) => void;
      }
    ).run(key, payload, now);
    try {
      (
        db.prepare(`DELETE FROM dynamic_average_cache WHERE key NOT IN
          (SELECT key FROM dynamic_average_cache ORDER BY generated_at DESC LIMIT ?)`) as {
          run: (...args: unknown[]) => void;
        }
      ).run(DYNAMIC_AVERAGE_PERSISTENT_MAX_ROWS);
    } catch {
      // Pruning must not break the response path.
    }
  } catch {
    // Persistent cache is best-effort and must never break the response.
  }
}

function startBackgroundRefresh<T>(key: string, load: () => Promise<T>, staleMs: number): void {
  const existing = entries.get(key) as Entry<T> | undefined;
  if (!existing || !existing.settled) return;
  existing.settled = false;
  const startedAt = Date.now();
  const promise = load();
  existing.promise = promise;
  existing.expiresAt = startedAt + TTL_MS;
  existing.staleAt = startedAt + TTL_MS + staleMs;
  promise.then(
    (value) => {
      const current = entries.get(key) as Entry<T> | undefined;
      if (current !== existing) return;
      existing.value = value;
      existing.hasValue = true;
      existing.settled = true;
      void writePersistentCache(key, value);
    },
    () => {
      const current = entries.get(key) as Entry<T> | undefined;
      if (current !== existing) return;
      existing.settled = true;
    },
  );
}

export async function loadDynamicAverage<T>(
  key: string,
  load: () => Promise<T>,
  now = Date.now(),
  options: DynamicAverageOptions = {},
): Promise<DynamicAverageResult<T>> {
  const staleMs = options.staleMs ?? 0;
  const budgetMs = options.budgetMs ?? Infinity;
  const usePersistent = options.persistent ?? true;

  const existing = entries.get(key) as Entry<T> | undefined;
  if (existing && existing.staleAt > now) {
    if (existing.expiresAt > now || !existing.settled) {
      entries.delete(key);
      entries.set(key, existing as Entry<unknown>);
      return { value: await withBudget(existing.promise, budgetMs), cache: "hit", stale: false };
    }
    if (existing.hasValue) {
      startBackgroundRefresh(key, load, staleMs);
      return { value: existing.value as T, cache: "hit", stale: true };
    }
  }

  const inflight = coldInflight.get(key) as Promise<DynamicAverageResult<T>> | undefined;
  if (inflight) {
    const shared = await withBudget(inflight, budgetMs);
    return { value: shared.value, cache: "hit", stale: shared.stale };
  }

  prune(now);
  const work: Promise<DynamicAverageResult<T>> = (async (): Promise<DynamicAverageResult<T>> => {
    if (usePersistent) {
      const persisted = await readPersistentCache<T>(key, now, staleMs);
      if (persisted) {
        const entry: Entry<T> = {
          promise: Promise.resolve(persisted.value),
          expiresAt: persisted.stale ? now - 1 : now + TTL_MS,
          staleAt: now + TTL_MS + staleMs,
          value: persisted.value,
          hasValue: true,
          settled: true,
        };
        entries.set(key, entry as Entry<unknown>);
        if (persisted.stale) {
          startBackgroundRefresh(key, load, staleMs);
          return { value: persisted.value, cache: "hit", stale: true };
        }
        return { value: persisted.value, cache: "hit", stale: false };
      }
    }
    const freshValue = await load();
    const entry: Entry<T> = {
      promise: Promise.resolve(freshValue),
      expiresAt: now + TTL_MS,
      staleAt: now + TTL_MS + staleMs,
      value: freshValue,
      hasValue: true,
      settled: true,
    };
    entries.set(key, entry as Entry<unknown>);
    await writePersistentCache(key, freshValue);
    return { value: freshValue, cache: "miss", stale: false };
  })();
  coldInflight.set(key, work as Promise<DynamicAverageResult<unknown>>);
  work.then(
    () => {
      if (coldInflight.get(key) === (work as Promise<DynamicAverageResult<unknown>>)) {
        coldInflight.delete(key);
      }
    },
    () => {
      if (coldInflight.get(key) === (work as Promise<DynamicAverageResult<unknown>>)) {
        coldInflight.delete(key);
      }
    },
  );
  return withBudget(work, budgetMs);
}

export function resetDynamicAverageCacheForTests(): void {
  entries.clear();
  coldInflight.clear();
}

export function resetDynamicAveragePersistentForTests(): void {
  try {
    persistentDb?.close?.();
  } catch {
    // Test reset must not throw when the database was never opened.
  }
  persistentDb = null;
  persistentPath = null;
}
