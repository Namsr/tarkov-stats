-- Arena eligible peer-scan hotpath (arena_mode + parser_version + games_count + hours).
-- Run once against the production D1 database:
--   wrangler d1 execute <DB_NAME> --remote --file=scripts/arena-risk-index-d1.sql
-- Safe to re-run. Does not modify already-applied migrations.
CREATE INDEX IF NOT EXISTS idx_arena_mode_stats_mode_parser ON arena_mode_stats(arena_mode, parser_version, games_count, hours);
