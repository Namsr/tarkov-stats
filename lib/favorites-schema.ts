// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function initializeFavoritesSchema(db: any): void {
  const cols = db.prepare("PRAGMA table_info(favorites)").all() as { name: string }[];
  if (cols.some((column) => column.name === "mode")) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      DROP INDEX IF EXISTS idx_favorites_user;
      ALTER TABLE favorites RENAME TO favorites_legacy;
      CREATE TABLE favorites (
        user_sub TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'regular',
        cycle_id TEXT NOT NULL DEFAULT 'persistent',
        aid INTEGER NOT NULL,
        nickname TEXT,
        note TEXT,
        is_main INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_sub, mode, cycle_id, aid)
      );
      INSERT INTO favorites (user_sub, mode, cycle_id, aid, nickname, note, is_main, created_at)
      SELECT user_sub, 'regular', 'persistent', aid, nickname, note, is_main, created_at
      FROM favorites_legacy;
      DROP TABLE favorites_legacy;
      CREATE INDEX idx_favorites_user_identity ON favorites(user_sub, mode, cycle_id);
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
