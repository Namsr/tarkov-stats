-- Upgrade an existing Seasonal D1 schema for score sample sizes and materialization generations.
-- Apply this migration once after seasonal-storage-d1.sql (the ALTER is intentionally one-shot).

ALTER TABLE progression_intervals ADD COLUMN score_sample_n INTEGER;

CREATE TABLE IF NOT EXISTS progression_materializations (
  mode TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  materialized_at INTEGER NOT NULL DEFAULT 0,
  score_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (mode, cycle_id)
);
