// Support page content: operator-authored notifications and the donation goal.
// The store runs both under Next.js (alias @/types) and plain node --experimental-strip-types.
// Keep the mode contract here so the module stays self-contained in both loaders.
const NOTIFICATION_LEVELS = ["info", "warn", "danger"] as const;
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];
function isNotificationLevel(value: unknown): value is NotificationLevel {
  return typeof value === "string" && (NOTIFICATION_LEVELS as readonly string[]).includes(value);
}

export interface SupportNotification {
  id: number;
  title: string;
  body: string;
  href: string | null;
  level: NotificationLevel;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface FundraisingGoal {
  id: number;
  collectedRub: number;
  goalRub: number;
  usdRate: number;
  isActive: boolean;
  updatedAt: number;
}

export interface SupportConfig {
  notifications: SupportNotification[];
  goal: FundraisingGoal | null;
}

export const SUPPORT_SCHEMA = `
CREATE TABLE IF NOT EXISTS support_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  href TEXT,
  level TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info','warn','danger')),
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_support_notifications_active
  ON support_notifications(is_active, id);

CREATE TABLE IF NOT EXISTS support_fundraising_goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collected_rub INTEGER NOT NULL DEFAULT 0,
  goal_rub INTEGER NOT NULL,
  usd_rate REAL NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SqliteDatabase = any;

export const SUPPORT_MAX_NOTIFICATIONS = 20;
export const SUPPORT_MAX_TITLE = 120;
export const SUPPORT_MAX_BODY = 1000;
export const SUPPORT_MAX_HREF = 300;

function supportPath(): string {
  return process.env.ADMIN_ANALYTICS_SQLITE_PATH || "/data/admin-analytics.db";
}

function validateId(id: number): void {
  if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError("invalid id");
}

function normalizeText(value: unknown, max: number, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new TypeError(`${field} is required`);
  if (text.length > max) throw new RangeError(`${field} is too long`);
  return text;
}

/** Notification links are operator-supplied, so restrict them to same-origin paths and https. */
export function normalizeHref(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new TypeError("invalid link");
  const text = value.trim();
  if (!text) return null;
  if (text.length > SUPPORT_MAX_HREF) throw new RangeError("link is too long");
  // "//host" is protocol-relative and would leave the origin, so only "/…" counts.
  if (text.startsWith("/")) {
    if (text.startsWith("//") || text.startsWith("/\\")) throw new TypeError("invalid link");
    return text;
  }
  if (!text.startsWith("https://")) throw new TypeError("link must be a path or an https URL");
  return text;
}

function validateLevel(value: unknown): NotificationLevel {
  if (!isNotificationLevel(value)) throw new TypeError("invalid level");
  return value;
}

function validateAmount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`invalid ${field}`);
  return Math.round(value);
}

function validateRate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new TypeError("invalid rate");
  return value;
}

function rowNotification(row: Record<string, unknown>): SupportNotification {
  return {
    id: Number(row.id),
    title: String(row.title),
    body: String(row.body),
    href: row.href == null ? null : String(row.href),
    level: isNotificationLevel(row.level) ? row.level : "info",
    isActive: Number(row.is_active) === 1,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowGoal(row: Record<string, unknown>): FundraisingGoal {
  return {
    id: Number(row.id),
    collectedRub: Number(row.collected_rub),
    goalRub: Number(row.goal_rub),
    usdRate: Number(row.usd_rate),
    isActive: Number(row.is_active) === 1,
    updatedAt: Number(row.updated_at),
  };
}

export interface SupportStore {
  listNotifications(): SupportNotification[];
  createNotification(input: { title: string; body: string; href?: string | null; level?: NotificationLevel }): SupportNotification;
  updateNotification(id: number, patch: { title?: string; body?: string; href?: string | null; level?: NotificationLevel }): SupportNotification;
  setNotificationActive(id: number, active: boolean): SupportNotification[];
  deleteNotification(id: number): SupportNotification[];
  listGoals(): FundraisingGoal[];
  createGoal(input: { collectedRub: number; goalRub: number; usdRate: number }): FundraisingGoal;
  updateGoal(id: number, patch: { collectedRub?: number; goalRub?: number; usdRate?: number }): FundraisingGoal;
  setGoalActive(id: number): FundraisingGoal[];
  deleteGoal(id: number): FundraisingGoal[];
  getActive(): SupportConfig;
}

export function createSupportStore(db: SqliteDatabase): SupportStore {
  db.exec(SUPPORT_SCHEMA);
  db.exec("PRAGMA foreign_keys = ON");

  function write<T>(operation: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function allNotifications(): SupportNotification[] {
    const rows = db.prepare("SELECT * FROM support_notifications ORDER BY id ASC").all() as Record<string, unknown>[];
    return rows.map(rowNotification);
  }

  function notificationById(id: number): SupportNotification | null {
    const row = db.prepare("SELECT * FROM support_notifications WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowNotification(row) : null;
  }

  function allGoals(): FundraisingGoal[] {
    const rows = db.prepare("SELECT * FROM support_fundraising_goals ORDER BY id ASC").all() as Record<string, unknown>[];
    return rows.map(rowGoal);
  }

  function goalById(id: number): FundraisingGoal | null {
    const row = db.prepare("SELECT * FROM support_fundraising_goals WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowGoal(row) : null;
  }

  return {
    listNotifications() {
      return allNotifications();
    },

    createNotification(input) {
      return write(() => {
        const title = normalizeText(input.title, SUPPORT_MAX_TITLE, "title");
        const body = normalizeText(input.body, SUPPORT_MAX_BODY, "body");
        const href = normalizeHref(input.href);
        const level = input.level === undefined ? "info" : validateLevel(input.level);
        const count = (db.prepare("SELECT COUNT(*) AS n FROM support_notifications").get() as { n: number }).n;
        if (count >= SUPPORT_MAX_NOTIFICATIONS) throw new RangeError("too many notifications");
        const now = Date.now();
        const info = db.prepare(
          "INSERT INTO support_notifications (title, body, href, level, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).run(title, body, href, level, 1, now, now);
        return notificationById(Number(info.lastInsertRowid))!;
      });
    },

    updateNotification(id, patch) {
      return write(() => {
        validateId(id);
        const current = notificationById(id);
        if (!current) throw new RangeError("notification not found");
        const title = patch.title === undefined ? current.title : normalizeText(patch.title, SUPPORT_MAX_TITLE, "title");
        const body = patch.body === undefined ? current.body : normalizeText(patch.body, SUPPORT_MAX_BODY, "body");
        const href = patch.href === undefined ? current.href : normalizeHref(patch.href);
        const level = patch.level === undefined ? current.level : validateLevel(patch.level);
        db.prepare("UPDATE support_notifications SET title = ?, body = ?, href = ?, level = ?, updated_at = ? WHERE id = ?").run(
          title, body, href, level, Date.now(), id
        );
        return notificationById(id)!;
      });
    },

    setNotificationActive(id, active) {
      return write(() => {
        validateId(id);
        if (!notificationById(id)) throw new RangeError("notification not found");
        // Unlike the homepage showcase, any number of notifications may stay live;
        // the operator turns each one on and off on its own row.
        db.prepare("UPDATE support_notifications SET is_active = ?, updated_at = ? WHERE id = ?").run(
          active ? 1 : 0, Date.now(), id
        );
        return allNotifications();
      });
    },

    deleteNotification(id) {
      return write(() => {
        validateId(id);
        if (!notificationById(id)) throw new RangeError("notification not found");
        db.prepare("DELETE FROM support_notifications WHERE id = ?").run(id);
        return allNotifications();
      });
    },

    listGoals() {
      return allGoals();
    },

    createGoal(input) {
      return write(() => {
        const goalRub = validateAmount(input.goalRub, "goal");
        if (goalRub <= 0) throw new TypeError("goal must be positive");
        const collectedRub = validateAmount(input.collectedRub ?? 0, "collected");
        const usdRate = validateRate(input.usdRate ?? 1);
        const count = (db.prepare("SELECT COUNT(*) AS n FROM support_fundraising_goals").get() as { n: number }).n;
        const now = Date.now();
        // The first goal goes live immediately; later ones stay as drafts to activate.
        const info = db.prepare(
          "INSERT INTO support_fundraising_goals (collected_rub, goal_rub, usd_rate, is_active, updated_at) VALUES (?, ?, ?, ?, ?)"
        ).run(collectedRub, goalRub, usdRate, count === 0 ? 1 : 0, now);
        return goalById(Number(info.lastInsertRowid))!;
      });
    },

    updateGoal(id, patch) {
      return write(() => {
        validateId(id);
        const current = goalById(id);
        if (!current) throw new RangeError("goal not found");
        const goalRub = patch.goalRub === undefined ? current.goalRub : validateAmount(patch.goalRub, "goal");
        if (goalRub <= 0) throw new TypeError("goal must be positive");
        const collectedRub = patch.collectedRub === undefined ? current.collectedRub : validateAmount(patch.collectedRub, "collected");
        const usdRate = patch.usdRate === undefined ? current.usdRate : validateRate(patch.usdRate);
        db.prepare("UPDATE support_fundraising_goals SET collected_rub = ?, goal_rub = ?, usd_rate = ?, updated_at = ? WHERE id = ?").run(
          collectedRub, goalRub, usdRate, Date.now(), id
        );
        return goalById(id)!;
      });
    },

    setGoalActive(id) {
      return write(() => {
        validateId(id);
        if (!goalById(id)) throw new RangeError("goal not found");
        const now = Date.now();
        db.prepare("UPDATE support_fundraising_goals SET is_active = 0").run();
        db.prepare("UPDATE support_fundraising_goals SET is_active = 1, updated_at = ? WHERE id = ?").run(now, id);
        return allGoals();
      });
    },

    deleteGoal(id) {
      return write(() => {
        validateId(id);
        if (!goalById(id)) throw new RangeError("goal not found");
        db.prepare("DELETE FROM support_fundraising_goals WHERE id = ?").run(id);
        return allGoals();
      });
    },

    getActive() {
      const rows = db.prepare("SELECT * FROM support_notifications WHERE is_active = 1 ORDER BY id ASC").all() as Record<string, unknown>[];
      const goalRow = db.prepare("SELECT * FROM support_fundraising_goals WHERE is_active = 1 ORDER BY id ASC LIMIT 1").get() as
        | Record<string, unknown>
        | undefined;
      return { notifications: rows.map(rowNotification), goal: goalRow ? rowGoal(goalRow) : null };
    },
  };
}

let storePromise: Promise<SupportStore | null> | null = null;
let retryAfter = 0;
let activePath: string | null = null;

export async function getSupportStore(): Promise<SupportStore | null> {
  const targetPath = supportPath();
  if (storePromise && activePath !== targetPath) {
    storePromise = null;
    activePath = null;
    retryAfter = 0;
  }
  if (!storePromise) {
    // Avoid repeating initialization and warnings on every request during an outage.
    if (Date.now() < retryAfter) return null;
    activePath = targetPath;
    storePromise = (async () => {
      let db: SqliteDatabase | null = null;
      try {
        const fs = await import("node:fs");
        const path = await import("node:path");
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sqlite = (await import("node:sqlite" as string)) as any;
        db = new sqlite.DatabaseSync(targetPath);
        db.exec("PRAGMA busy_timeout = 5000;");
        return createSupportStore(db);
      } catch (error) {
        try { db?.close(); } catch { /* Preserve the initialization error. */ }
        console.warn("support content unavailable: " + (error as Error).message);
        retryAfter = Date.now() + 5_000;
        storePromise = null;
        return null;
      }
    })();
  }
  return storePromise;
}
