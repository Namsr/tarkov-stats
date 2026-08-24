-- PvE nickname directory. The mode column keeps future mode-aware readers from
-- accidentally treating a PvE name as a regular PvP result.
CREATE TABLE IF NOT EXISTS pve_player_index (
  mode TEXT NOT NULL CHECK (mode = 'pve'),
  aid INTEGER NOT NULL,
  nickname TEXT NOT NULL,
  nickname_lower TEXT NOT NULL,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (mode, aid)
);

CREATE INDEX IF NOT EXISTS idx_pve_player_index_nickname_lower
  ON pve_player_index(mode, nickname_lower, aid);

CREATE TABLE IF NOT EXISTS pve_player_index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
