-- One-time D1 migration for the current Seasonal comparison portrait.
ALTER TABLE player_profiles ADD COLUMN total_raids INTEGER;
ALTER TABLE player_profiles ADD COLUMN survived INTEGER;
ALTER TABLE player_profiles ADD COLUMN deaths INTEGER;
ALTER TABLE player_profiles ADD COLUMN total_kills INTEGER;
ALTER TABLE player_profiles ADD COLUMN longest_win_streak INTEGER;
ALTER TABLE player_profiles ADD COLUMN level INTEGER;

UPDATE player_profiles SET
  total_raids = (SELECT total_raids FROM progression_snapshots s
    WHERE s.mode = player_profiles.mode AND s.cycle_id = player_profiles.cycle_id
      AND s.aid = player_profiles.aid ORDER BY profile_updated_at DESC, id DESC LIMIT 1),
  survived = (SELECT survived FROM progression_snapshots s
    WHERE s.mode = player_profiles.mode AND s.cycle_id = player_profiles.cycle_id
      AND s.aid = player_profiles.aid ORDER BY profile_updated_at DESC, id DESC LIMIT 1),
  deaths = (SELECT deaths FROM progression_snapshots s
    WHERE s.mode = player_profiles.mode AND s.cycle_id = player_profiles.cycle_id
      AND s.aid = player_profiles.aid ORDER BY profile_updated_at DESC, id DESC LIMIT 1),
  total_kills = (SELECT total_kills FROM progression_snapshots s
    WHERE s.mode = player_profiles.mode AND s.cycle_id = player_profiles.cycle_id
      AND s.aid = player_profiles.aid ORDER BY profile_updated_at DESC, id DESC LIMIT 1),
  longest_win_streak = (SELECT longest_win_streak FROM progression_snapshots s
    WHERE s.mode = player_profiles.mode AND s.cycle_id = player_profiles.cycle_id
      AND s.aid = player_profiles.aid ORDER BY profile_updated_at DESC, id DESC LIMIT 1),
  level = (SELECT level FROM progression_snapshots s
    WHERE s.mode = player_profiles.mode AND s.cycle_id = player_profiles.cycle_id
      AND s.aid = player_profiles.aid ORDER BY profile_updated_at DESC, id DESC LIMIT 1)
WHERE mode = 'seasonal';

CREATE INDEX IF NOT EXISTS idx_player_profiles_comparison
  ON player_profiles(mode, cycle_id, confirmed_banned, lifetime_pvp_hours, pmc_raids, aid);
