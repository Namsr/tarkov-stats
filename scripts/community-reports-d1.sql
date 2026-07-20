CREATE TABLE IF NOT EXISTS suspect_reports (
  user_sub TEXT NOT NULL,
  aid INTEGER NOT NULL,
  mode TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_sub, aid)
);
CREATE INDEX IF NOT EXISTS idx_suspect_reports_aid_time ON suspect_reports(aid, created_at);

CREATE TABLE IF NOT EXISTS ban_review_votes (
  helper_id TEXT NOT NULL,
  aid INTEGER NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('yes', 'no')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (helper_id, aid)
);
CREATE INDEX IF NOT EXISTS idx_ban_review_votes_aid_time ON ban_review_votes(aid, created_at);
