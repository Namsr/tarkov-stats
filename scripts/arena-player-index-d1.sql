CREATE TABLE IF NOT EXISTS arena_player_index (
  mode TEXT NOT NULL CHECK (mode = 'arena'),
  aid INTEGER NOT NULL,
  nickname TEXT NOT NULL,
  nickname_lower TEXT NOT NULL,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (mode, aid)
);

CREATE INDEX IF NOT EXISTS idx_arena_player_index_nickname_lower
  ON arena_player_index(mode, nickname_lower, aid);

CREATE TABLE IF NOT EXISTS arena_player_index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
