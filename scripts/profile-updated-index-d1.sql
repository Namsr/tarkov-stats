-- Run once after scripts/profile-version-d1.sql. Safe to re-run.
CREATE INDEX IF NOT EXISTS idx_players_profile_updated_at
ON players(profile_updated_at);
