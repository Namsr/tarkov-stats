import type { LeaderboardMode } from "./leaderboard";
import type { ArenaModeKey } from "./arena";

export interface LeaderboardPreviewScope {
  mode: LeaderboardMode;
  cycleId: string | null;
  arenaMode: ArenaModeKey | null;
}

export interface LeaderboardPreviewMetric {
  label: string;
  value: number | null;
  average: number | null;
  digits: number;
  percent?: boolean;
}

export interface LeaderboardPreview extends LeaderboardPreviewScope {
  aid: number;
  nickname: string;
  side: string | null;
  level: number | null;
  prestige: number | null;
  updatedAt: number | null;
  hours: number | null;
  raids: number | null;
  metrics: LeaderboardPreviewMetric[];
  totals: { label: string; value: number | null }[];
}
