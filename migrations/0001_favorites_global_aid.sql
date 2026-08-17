-- Versioned follow-up for D1 databases that already ran scripts/favorites-d1.sql.
-- Apply this migration before deploying the global-AID application build:
--
--   npx wrangler d1 migrations apply <DATABASE_NAME> --remote
--
-- Keep this file in the configured D1 migrations_dir. Wrangler records the
-- filename, skips it after success, and rolls the migration back on failure.

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
);

INSERT INTO favorites_global
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
GROUP BY f.user_sub, f.aid;

UPDATE favorites_global AS favorite
SET is_main = 0
WHERE is_main <> 0 AND aid <> (
  SELECT winner.aid FROM favorites_global winner
  WHERE winner.user_sub = favorite.user_sub AND winner.is_main <> 0
  ORDER BY winner.created_at DESC, winner.aid ASC LIMIT 1
);

DROP TABLE favorites;
ALTER TABLE favorites_global RENAME TO favorites;
CREATE INDEX idx_favorites_user_identity ON favorites(user_sub, mode, cycle_id);
