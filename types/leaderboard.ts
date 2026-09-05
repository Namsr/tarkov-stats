import type { ArenaModeKey } from "@/types/arena";

export type LeaderboardMode = "regular" | "pve" | "arena" | "pvp-season";
export type LeaderboardPrimaryMetric = "performance" | "arp" | "killsPerMatch";
export type LeaderboardSort = "primary" | "kd" | "killsPerMatch" | "hours";
export type LeaderboardSubjectStatus =
  | "ranked"
  | "insufficient_sample"
  | "missing_metrics"
  | "inactive"
  | "season_unverified"
  | "reference_unavailable"
  | "excluded";
export type LeaderboardPublicationStatus = "ready" | "stale" | "publishing" | "error";

export interface LeaderboardStats {
  raidsOrMatches: number | null;
  kills: number | null;
  deaths: number | null;
  kd: number | null;
  deathless: boolean;
  killsPerMatch: number | null;
  hours: number | null;
  /** Value used for ARP ordering: current when available, otherwise confirmed best. */
  arp: number | null;
  currentArp: number | null;
  bestArp: number | null;
  arpSource: "current" | "best" | null;
}

export interface LeaderboardRow {
  aid: number;
  nickname: string;
  /** Position in the selected sort. Null when the selected metric is unavailable. */
  position: number | null;
  /** Position in the mode's primary order, even when another sort is selected. */
  primaryRank: number | null;
  /** First shared group position, rendered as `#(groupStart)+`. */
  groupStart: number | null;
  status: LeaderboardSubjectStatus;
  score: number | null;
  stats: LeaderboardStats;
  selected: boolean;
}

export interface ArenaLeaderboardTab {
  mode: ArenaModeKey;
  /** Unique, non-excluded profiles whose match counter is known. Zero counts. */
  knownMatchProfiles: number;
}

export interface LeaderboardMeta {
  generation: number;
  generatedAt: number;
  formulaVersion: number;
  publicationStatus: LeaderboardPublicationStatus;
  mode: LeaderboardMode;
  /** Active server-configured PvP season; null for persistent modes and Arena. */
  cycleId: string | null;
  arenaMode: ArenaModeKey | null;
  sort: LeaderboardSort;
  primaryMetric: LeaderboardPrimaryMetric;
  /** Counts reflect live exclusions, not only the published snapshot. */
  rankedCount: number;
  groupCount: number;
  arenaTabs: ArenaLeaderboardTab[] | null;
}

export interface LeaderboardRankResponse {
  meta: LeaderboardMeta;
  subject: LeaderboardRow;
}

export interface LeaderboardPageResponse {
  meta: LeaderboardMeta;
  top: LeaderboardRow[];
  around: LeaderboardRow[] | null;
  subject: LeaderboardRow | null;
}

export interface LeaderboardErrorResponse {
  code: "invalid_leaderboard_request" | "leaderboard_unavailable" | "leaderboard_subject_not_found";
  error: string;
}
