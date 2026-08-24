-- One-shot upgrade for an existing D1 database created before Seasonal
-- weapon mastery snapshots were added. Fresh databases use the full schema.
ALTER TABLE progression_snapshots ADD COLUMN weapon_mastery TEXT;
