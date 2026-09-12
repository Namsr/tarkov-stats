export interface ShowcaseItem {
  aid: number;
  nickname: string | null;
  enabled: boolean;
  sort: number;
}

export interface ShowcaseGroup {
  id: number;
  name: string;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
  items: ShowcaseItem[];
}

export interface ShowcaseConfig {
  groupId: number | null;
  groupName: string | null;
  aids: number[];
  items: ShowcaseItem[];
  updatedAt: number | null;
}

export const SHOWCASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS home_showcase_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS home_showcase_items (
  group_id INTEGER NOT NULL REFERENCES home_showcase_groups(id) ON DELETE CASCADE,
  aid INTEGER NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  nickname TEXT,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, aid)
);
CREATE INDEX IF NOT EXISTS idx_home_showcase_items_group
  ON home_showcase_items(group_id, sort, aid);
`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SqliteDatabase = any;

export const SHOWCASE_MAX_GROUPS = 20;
export const SHOWCASE_MAX_ITEMS = 20;
export const SHOWCASE_MAX_NAME = 80;
export const SHOWCASE_MAX_NICKNAME = 64;

function showcasePath(): string {
  return process.env.ADMIN_ANALYTICS_SQLITE_PATH || "/data/admin-analytics.db";
}

function validateAid(aid: number): void {
  if (!Number.isSafeInteger(aid) || aid <= 0) throw new TypeError("invalid aid");
}

function validateGroupId(id: number): void {
  if (!Number.isSafeInteger(id) || id <= 0) throw new TypeError("invalid group");
}

function normalizeName(name: string): string {
  const text = name?.trim() ?? "";
  if (!text) throw new TypeError("name is required");
  if (text.length > SHOWCASE_MAX_NAME) throw new TypeError("name is too long");
  return text;
}

function normalizeNickname(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  if (!text) return null;
  if (text.length > SHOWCASE_MAX_NICKNAME) throw new TypeError("nickname is too long");
  return text;
}

function rowToItem(row: Record<string, unknown>): ShowcaseItem {
  return {
    aid: Number(row.aid),
    nickname: row.nickname == null ? null : String(row.nickname),
    enabled: Number(row.enabled) === 1,
    sort: Number(row.sort),
  };
}

export interface ShowcaseStore {
  listGroups(): ShowcaseGroup[];
  getActive(): ShowcaseConfig;
  createGroup(name: string): ShowcaseGroup;
  renameGroup(id: number, name: string): ShowcaseGroup;
  deleteGroup(id: number): void;
  setActive(id: number): ShowcaseGroup[];
  addItem(groupId: number, aid: number, nickname?: string | null): ShowcaseGroup;
  removeItem(groupId: number, aid: number): ShowcaseGroup;
  updateItem(groupId: number, aid: number, patch: { enabled?: boolean; nickname?: string | null }): ShowcaseGroup;
  reorder(groupId: number, aids: number[]): ShowcaseGroup;
}

export function createShowcaseStore(db: SqliteDatabase): ShowcaseStore {
  db.exec(SHOWCASE_SCHEMA);
  db.exec("PRAGMA foreign_keys = ON");

  function groupById(id: number): ShowcaseGroup | null {
    const row = db.prepare("SELECT * FROM home_showcase_groups WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    const items = db.prepare(
      "SELECT aid, nickname, enabled, sort FROM home_showcase_items WHERE group_id = ? ORDER BY sort ASC, aid ASC"
    ).all(id) as Record<string, unknown>[];
    return {
      id: Number(row.id),
      name: String(row.name),
      isActive: Number(row.is_active) === 1,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      items: items.map(rowToItem),
    };
  }

  function allGroups(): ShowcaseGroup[] {
    const rows = db.prepare("SELECT * FROM home_showcase_groups ORDER BY id ASC").all() as Record<string, unknown>[];
    return rows.map((row) => {
      const items = db.prepare(
        "SELECT aid, nickname, enabled, sort FROM home_showcase_items WHERE group_id = ? ORDER BY sort ASC, aid ASC"
      ).all(Number(row.id)) as Record<string, unknown>[];
      return {
        id: Number(row.id),
        name: String(row.name),
        isActive: Number(row.is_active) === 1,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        items: items.map(rowToItem),
      };
    });
  }

  function touch(groupId: number, now: number): void {
    db.prepare("UPDATE home_showcase_groups SET updated_at = ? WHERE id = ?").run(now, groupId);
  }

  function nextSort(groupId: number): number {
    const row = db.prepare("SELECT COALESCE(MAX(sort), -1) + 1 AS nextSort FROM home_showcase_items WHERE group_id = ?").get(groupId) as
      | { nextSort: number }
      | undefined;
    return Number(row?.nextSort ?? 0);
  }

  return {
    listGroups() {
      return allGroups();
    },

    getActive() {
      const row = db.prepare("SELECT * FROM home_showcase_groups WHERE is_active = 1 ORDER BY id ASC LIMIT 1").get() as
        | Record<string, unknown>
        | undefined;
      if (!row) return { groupId: null, groupName: null, aids: [], items: [], updatedAt: null };
      const groupId = Number(row.id);
      const items = (db.prepare(
        "SELECT aid, nickname, enabled, sort FROM home_showcase_items WHERE group_id = ? AND enabled = 1 ORDER BY sort ASC, aid ASC"
      ).all(groupId) as Record<string, unknown>[]).map(rowToItem);
      return {
        groupId,
        groupName: String(row.name),
        aids: items.map((item) => item.aid),
        items,
        updatedAt: Number(row.updated_at),
      };
    },

    createGroup(name) {
      const clean = normalizeName(name);
      const count = (db.prepare("SELECT COUNT(*) AS n FROM home_showcase_groups").get() as { n: number }).n;
      if (count >= SHOWCASE_MAX_GROUPS) throw new RangeError("too many groups");
      const now = Date.now();
      const existing = (db.prepare("SELECT COUNT(*) AS n FROM home_showcase_groups").get() as { n: number }).n;
      const info = db.prepare(
        "INSERT INTO home_showcase_groups (name, is_active, created_at, updated_at) VALUES (?, ?, ?, ?)"
      ).run(clean, existing === 0 ? 1 : 0, now, now);
      return groupById(Number(info.lastInsertRowid))!;
    },

    renameGroup(id, name) {
      validateGroupId(id);
      const clean = normalizeName(name);
      const group = groupById(id);
      if (!group) throw new RangeError("group not found");
      const now = Date.now();
      db.prepare("UPDATE home_showcase_groups SET name = ?, updated_at = ? WHERE id = ?").run(clean, now, id);
      return groupById(id)!;
    },

    deleteGroup(id) {
      validateGroupId(id);
      const group = groupById(id);
      if (!group) throw new RangeError("group not found");
      const wasActive = group.isActive;
      db.prepare("DELETE FROM home_showcase_items WHERE group_id = ?").run(id);
      db.prepare("DELETE FROM home_showcase_groups WHERE id = ?").run(id);
      if (wasActive) {
        const next = db.prepare("SELECT id FROM home_showcase_groups ORDER BY id ASC LIMIT 1").get() as
          | { id: number }
          | undefined;
        if (next) db.prepare("UPDATE home_showcase_groups SET is_active = 1, updated_at = ? WHERE id = ?").run(Date.now(), Number(next.id));
      }
    },

    setActive(id) {
      validateGroupId(id);
      if (!groupById(id)) throw new RangeError("group not found");
      const now = Date.now();
      db.prepare("UPDATE home_showcase_groups SET is_active = 0").run();
      db.prepare("UPDATE home_showcase_groups SET is_active = 1, updated_at = ? WHERE id = ?").run(now, id);
      return allGroups();
    },

    addItem(groupId, aid, nickname) {
      validateGroupId(groupId);
      validateAid(aid);
      const group = groupById(groupId);
      if (!group) throw new RangeError("group not found");
      if (group.items.length >= SHOWCASE_MAX_ITEMS) throw new RangeError("group is full");
      if (group.items.some((item) => item.aid === aid)) throw new RangeError("already in group");
      const now = Date.now();
      db.prepare(
        "INSERT INTO home_showcase_items (group_id, aid, sort, enabled, nickname, added_at) VALUES (?, ?, ?, 1, ?, ?)"
      ).run(groupId, aid, nextSort(groupId), normalizeNickname(nickname), now);
      touch(groupId, now);
      return groupById(groupId)!;
    },

    removeItem(groupId, aid) {
      validateGroupId(groupId);
      validateAid(aid);
      if (!groupById(groupId)) throw new RangeError("group not found");
      db.prepare("DELETE FROM home_showcase_items WHERE group_id = ? AND aid = ?").run(groupId, aid);
      touch(groupId, Date.now());
      return groupById(groupId)!;
    },

    updateItem(groupId, aid, patch) {
      validateGroupId(groupId);
      validateAid(aid);
      const group = groupById(groupId);
      if (!group) throw new RangeError("group not found");
      if (!group.items.some((item) => item.aid === aid)) throw new RangeError("item not found");
      const current = group.items.find((item) => item.aid === aid)!;
      const enabled = patch.enabled ?? current.enabled;
      const nickname = patch.nickname !== undefined ? normalizeNickname(patch.nickname) : current.nickname;
      db.prepare("UPDATE home_showcase_items SET enabled = ?, nickname = ? WHERE group_id = ? AND aid = ?").run(
        enabled ? 1 : 0, nickname, groupId, aid
      );
      touch(groupId, Date.now());
      return groupById(groupId)!;
    },

    reorder(groupId, aids) {
      validateGroupId(groupId);
      const group = groupById(groupId);
      if (!group) throw new RangeError("group not found");
      if (!Array.isArray(aids) || aids.length !== group.items.length) throw new TypeError("invalid order");
      const known = new Set(group.items.map((item) => item.aid));
      if (!aids.every((aid) => Number.isSafeInteger(aid) && known.has(aid)) || new Set(aids).size !== aids.length) {
        throw new TypeError("invalid order");
      }
      const now = Date.now();
      const update = db.prepare("UPDATE home_showcase_items SET sort = ? WHERE group_id = ? AND aid = ?");
      aids.forEach((aid, index) => update.run(index, groupId, aid));
      touch(groupId, now);
      return groupById(groupId)!;
    },
  };
}

let dbPromise: Promise<SqliteDatabase> | null = null;

async function getDb(): Promise<SqliteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const file = showcasePath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sqlite = (await import("node:sqlite" as string)) as any;
      const db = new sqlite.DatabaseSync(file);
      db.exec("PRAGMA busy_timeout = 5000;");
      return db;
    })();
  }
  return dbPromise;
}

let storePromise: Promise<ShowcaseStore> | null = null;

export async function getShowcaseStore(): Promise<ShowcaseStore | null> {
  if (!storePromise) {
    storePromise = (async () => {
      try {
        return createShowcaseStore(await getDb());
      } catch (error) {
        console.warn("home showcase unavailable: " + (error as Error).message);
        return null as unknown as ShowcaseStore;
      }
    })();
  }
  const store = await storePromise;
  return store ?? null;
}
