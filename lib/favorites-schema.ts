export const MAX_FAVORITES = 50;

export const FAVORITE_INSERT_SQL = `INSERT OR IGNORE INTO favorites
  (user_sub, mode, cycle_id, aid, nickname, note, is_main, created_at)
  SELECT ?, ?, ?, ?, ?, ?, 0, ?
  WHERE NOT EXISTS (SELECT 1 FROM favorites WHERE user_sub = ? AND aid = ?)
    AND (SELECT COUNT(DISTINCT aid) FROM favorites WHERE user_sub = ?) < ?`;

export const FAVORITE_SET_MAIN_SQL = `UPDATE favorites
  SET is_main = CASE WHEN aid = ? THEN 1 ELSE 0 END
  WHERE user_sub = ? AND EXISTS (
    SELECT 1 FROM favorites WHERE user_sub = ? AND aid = ?
  )`;

export function favoriteInsertResult(
  changes: number,
  exists: boolean,
  count: number,
): "ok" | "exists" | "limit" {
  if (changes === 1) return "ok";
  if (exists) return "exists";
  if (count >= MAX_FAVORITES) return "limit";
  throw new Error("Favorite insert was ignored unexpectedly");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function initializeFavoritesSchema(db: any): void {
  const cols = db.prepare("PRAGMA table_info(favorites)").all() as { name: string; pk: number }[];
  const hasIdentity = cols.some((column) => column.name === "mode");
  const primaryKey = cols
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name)
    .join(",");
  if (hasIdentity && primaryKey === "user_sub,aid") return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`DROP TABLE IF EXISTS favorites_global;
      CREATE TABLE favorites_global (
        user_sub TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'regular',
        cycle_id TEXT NOT NULL DEFAULT 'persistent',
        aid INTEGER NOT NULL,
        nickname TEXT,
        note TEXT,
        is_main INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_sub, aid)
      )`);
    if (hasIdentity) {
      db.exec(`INSERT INTO favorites_global
        (user_sub, mode, cycle_id, aid, nickname, note, is_main, created_at)
        SELECT f.user_sub,
          (SELECT f2.mode FROM favorites f2
            WHERE f2.user_sub = f.user_sub AND f2.aid = f.aid
            ORDER BY (f2.mode = 'regular') DESC, f2.created_at DESC, f2.rowid DESC LIMIT 1),
          (SELECT f2.cycle_id FROM favorites f2
            WHERE f2.user_sub = f.user_sub AND f2.aid = f.aid
            ORDER BY (f2.mode = 'regular') DESC, f2.created_at DESC, f2.rowid DESC LIMIT 1),
          f.aid,
          (SELECT f2.nickname FROM favorites f2
            WHERE f2.user_sub = f.user_sub AND f2.aid = f.aid AND f2.nickname IS NOT NULL AND f2.nickname <> ''
            ORDER BY f2.created_at DESC, f2.rowid DESC LIMIT 1),
          (SELECT f2.note FROM favorites f2
            WHERE f2.user_sub = f.user_sub AND f2.aid = f.aid AND f2.note IS NOT NULL AND f2.note <> ''
            ORDER BY f2.created_at DESC, f2.rowid DESC LIMIT 1),
          MAX(f.is_main), MIN(f.created_at)
        FROM favorites f
        GROUP BY f.user_sub, f.aid`);
    } else {
      db.exec(`INSERT INTO favorites_global
        (user_sub, mode, cycle_id, aid, nickname, note, is_main, created_at)
        SELECT user_sub, 'regular', 'persistent', aid, nickname, note, is_main, created_at
        FROM favorites`);
    }
    db.exec(`UPDATE favorites_global AS favorite
      SET is_main = 0
      WHERE is_main <> 0 AND aid <> (
        SELECT winner.aid FROM favorites_global winner
        WHERE winner.user_sub = favorite.user_sub AND winner.is_main <> 0
        ORDER BY winner.created_at DESC, winner.aid ASC LIMIT 1
      );
      DROP TABLE favorites;
      ALTER TABLE favorites_global RENAME TO favorites;
      CREATE INDEX idx_favorites_user_identity ON favorites(user_sub, mode, cycle_id);`);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original migration failure if SQLite already rolled back.
    }
    throw error;
  }
}
