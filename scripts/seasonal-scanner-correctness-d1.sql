-- Upgrade an already deployed Seasonal D1 schema without discarding history.
-- Apply once after the earlier Seasonal storage/scanner migrations.
ALTER TABLE scan_task_outcomes ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
DROP INDEX IF EXISTS idx_scan_task_outcomes_task;
CREATE UNIQUE INDEX IF NOT EXISTS idx_scan_task_outcomes_task_attempt
  ON scan_task_outcomes(run_id, task_id, attempt);

-- Eligibility requires two valid intervals with changed cumulative counters,
-- not merely two snapshots or different upstream timestamps.
UPDATE player_profiles SET progression_eligible = CASE WHEN confirmed_banned = 0 AND (
  SELECT COUNT(*) FROM progression_intervals interval
  WHERE interval.mode = player_profiles.mode AND interval.cycle_id = player_profiles.cycle_id
    AND interval.aid = player_profiles.aid AND interval.status = 'valid' AND (
      interval.experience <> 0 OR interval.pmc_raids <> 0 OR interval.scav_raids <> 0 OR
      interval.pmc_survived <> 0 OR interval.pmc_deaths <> 0 OR interval.pmc_kills <> 0 OR
      interval.killed_pmc <> 0
    )
) >= 2 THEN 1 ELSE 0 END WHERE mode = 'seasonal';
