-- One-shot upgrade for an existing D1 database created from an older Seasonal schema.
-- Run once before deploying code that reads common_skills.
-- Fresh databases must use the updated scripts/seasonal-storage-d1.sql only.
-- Do not run this ALTER on a fresh database or after applying the full schema.

ALTER TABLE progression_snapshots ADD COLUMN common_skills TEXT;
