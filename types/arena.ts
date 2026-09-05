export const ARENA_MODE_KEYS = [
  "teamFight",
  "lastHero",
  "checkpoint",
  "blastGang",
  "shootOutDuo",
] as const;

export type ArenaModeKey = (typeof ARENA_MODE_KEYS)[number];
export type ArenaStoredMode = ArenaModeKey | "overall";
/** Internal symbol retaining the upstream counter objects for normalized storage. */
export const ARENA_RAW_COUNTERS = Symbol("arenaRawCounters");

export const ARENA_METRIC_KEYS = [
  "kd_ratio",
  "win_rate",
  "headshot_rate",
  "kills_per_match",
  "damage_per_match",
] as const;

export type ArenaMetricKey = (typeof ARENA_METRIC_KEYS)[number];
export type ArenaStatistic = "trimmed_mean" | "median";
export type ArenaDimension = "hours" | "matches";

/** Raw Arena counters stay nullable: a missing upstream counter is not a zero. */
export interface ArenaCounters {
  matches: number | null;
  wins: number | null;
  losses: number | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  headshots: number | null;
  damage: number | null;
  round_mvp: number | null;
  match_mvp: number | null;
  current_kill_streak: number | null;
  max_kill_streak: number | null;
  current_win_streak: number | null;
  max_win_streak: number | null;
  current_loss_streak: number | null;
  max_loss_streak: number | null;
}

export type ArenaMetrics = Record<ArenaMetricKey, number | null>;

export interface ArenaModeStats {
  mode: ArenaModeKey;
  /** Arena only publishes a global playtime counter, never a per-mode one. */
  hours: number | null;
  counters: ArenaCounters;
  metrics: ArenaMetrics;
}

export interface ArenaOverallStats {
  hours: number | null;
  counters: ArenaCounters;
  metrics: ArenaMetrics;
  /** Exact upstream UnrankedOverall BestArp. Null means the counter was absent. */
  bestArp: number | null;
  /** Direct upstream totals win. Complete five-mode sums are the only fallback. */
  source: "upstream" | "complete_mode_sum" | "unavailable";
}

/** Public Arena payload. It deliberately does not reuse standard PvP statistics. */
export interface ArenaProfile {
  aid: number;
  nickname: string;
  profileUpdatedAt: number;
  /** Local snapshot time; unlike profileUpdatedAt, this is not upstream data. */
  fetchedAt: number | null;
  parserVersion: number;
  overall: ArenaOverallStats;
  modes: Record<ArenaModeKey, ArenaModeStats>;
  [ARENA_RAW_COUNTERS]?: Partial<Record<ArenaStoredMode, unknown>>;
}

export interface ArenaMetricValue {
  value: number | null;
  count: number;
  /** Explains why an aggregate is unavailable without inventing a zero. */
  reason: "no_valid_values" | "insufficient_values" | null;
}

export interface ArenaRangeBounds {
  min: number | null;
  max: number | null;
}

export interface ArenaAverageInput {
  mode: ArenaStoredMode;
  statistic?: ArenaStatistic;
  dimension?: ArenaDimension;
  /** `players` makes buckets count players; a metric makes them chart that metric. */
  metric?: "players" | ArenaMetricKey;
  minHours?: number | null;
  maxHours?: number | null;
  minMatches?: number | null;
  maxMatches?: number | null;
}

export interface ArenaAverageBucket {
  min: number;
  max: number | null;
  sampleN: number;
  metrics: Record<ArenaMetricKey, ArenaMetricValue>;
}

export interface ArenaAverageResult {
  filterIdentity: Required<Pick<ArenaAverageInput, "mode" | "statistic" | "dimension" | "metric">> & {
    minHours: number | null;
    maxHours: number | null;
    minMatches: number | null;
    maxMatches: number | null;
  };
  sampleN: number;
  total: number;
  coverage: Record<ArenaMetricKey, number>;
  bounds: { hours: ArenaRangeBounds; matches: ArenaRangeBounds };
  metrics: Record<ArenaMetricKey, ArenaMetricValue>;
  buckets: ArenaAverageBucket[];
  population: {
    scannedAccounts: number;
    playedAccounts: Record<ArenaModeKey, number>;
  };
}

interface ArenaCohortBase {
  aid: number;
  statistic: ArenaStatistic;
  target: { hours: number | null; matches: number | null };
  percent: 10 | 15 | 20 | 30;
  bounds: { hours: ArenaRangeBounds; matches: ArenaRangeBounds };
  sampleN: number;
  required: number;
  quality: "sufficient" | "unavailable";
  reason: "target_unavailable" | "insufficient_cohort" | null;
  metrics: Record<ArenaMetricKey, ArenaMetricValue>;
}

export interface ArenaMatchedCohortResult extends ArenaCohortBase {
  mode: ArenaModeKey;
  strategy: "matched";
}

export interface ArenaPopulationCohortResult extends ArenaCohortBase {
  mode: "overall";
  strategy: "population";
}

export type ArenaCohortResult = ArenaMatchedCohortResult | ArenaPopulationCohortResult;

export type ArenaRiskTier = "low" | "medium" | "high" | "severe";

export interface ArenaRiskMetric {
  value: number | null;
  count: number;
  mean: number | null;
  std: number | null;
  z: number | null;
  points: number | null;
  available: boolean;
  reason: "missing_metric" | "insufficient_peers" | "zero_std" | null;
}

export interface ArenaModeRisk {
  mode: ArenaModeKey;
  score: number | null;
  peerCount: number;
  percent: 10 | 15 | 20 | 30;
  reasons: string[];
  metrics: Record<Exclude<ArenaMetricKey, "headshot_rate">, ArenaRiskMetric>;
}

export interface ArenaOverallRisk {
  mode: "overall";
  score: number | null;
  peerCount: number;
  reasons: string[];
  metrics: Record<Exclude<ArenaMetricKey, "headshot_rate">, ArenaRiskMetric>;
}

export interface ArenaProfileRisk {
  aid: number;
  score: number | null;
  tier: ArenaRiskTier | null;
  overall: ArenaOverallRisk;
  modes: ArenaModeRisk[];
  freshness: { fetchedAt: number | null; profileUpdatedAt: number | null; evaluatedAt: number };
  version: { upstream: number | null; parser: number | null; calculation: number };
}
