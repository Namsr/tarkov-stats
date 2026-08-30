CREATE TABLE IF NOT EXISTS achievement_baseline_publications (
  mode TEXT PRIMARY KEY CHECK (mode IN ('regular', 'pve')),
  generation INTEGER NOT NULL,
  generated_at INTEGER NOT NULL,
  total INTEGER NOT NULL,
  achievements_json TEXT NOT NULL
);
