-- Apply once to an existing Arena D1 database to enable the Best ARP leaderboard.
-- Fresh databases already include best_arp via arena-storage-d1.sql.
-- (Run once: SQLite/D1 ALTER TABLE fails if the column already exists.)
ALTER TABLE arena_mode_stats ADD COLUMN best_arp REAL;
ALTER TABLE arena_mode_stats_history ADD COLUMN best_arp REAL;
CREATE INDEX IF NOT EXISTS idx_arena_mode_stats_best_arp
  ON arena_mode_stats(arena_mode, best_arp DESC, games_count DESC, kd_ratio DESC);
