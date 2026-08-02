export const GAME_MODES = ["regular", "pve", "arena", "seasonal"] as const;

export type GameMode = (typeof GAME_MODES)[number];
export type CycleId = string;

/** Legacy routes and rows without an explicit identity remain regular/persistent. */
export const LEGACY_IDENTITY = {
  mode: "regular",
  cycleId: "persistent",
} as const satisfies Pick<ProfileIdentity, "mode" | "cycleId">;

export interface ProfileIdentity {
  mode: GameMode;
  cycleId: CycleId;
  aid: number;
}

export interface SeasonCycle {
  cycleId: CycleId;
  mode: "seasonal";
  startsAt: number;
  endsAt: number | null;
  enabled: boolean;
  upstreamContract: "game_mode" | "profile_section" | null;
}

/** Canonical cumulative fields shared by snapshots, intervals, and formulas. */
export interface SeasonalCounters {
  experience: number;
  pmcRaids: number;
  scavRaids: number;
  pmcSurvived: number;
  pmcDeaths: number;
  pmcKills: number;
  killedPmc: number;
}

/** Runtime-validated representation produced by either supported upstream shape. */
export interface SeasonalProfile extends ProfileIdentity {
  nickname: string;
  profileUpdatedAt: number;
  lastAccessAt: number;
  lifetimePvpHours: number | null;
  counters: SeasonalCounters;
  /** Optional single-profile signals consumed by the existing static risk model. */
  staticSignals?: {
    prestige: number;
    longestWinStreak: number;
    achievementIds: string[];
  };
}

export interface PlayerProfileRecord extends SeasonalProfile {
  firstSeenAt: number;
  lastSeenAt: number;
  snapshotCount: number;
  confirmedBanned: boolean;
}

export interface ProgressionSnapshotRecord extends ProfileIdentity {
  id: number;
  profileUpdatedAt: number;
  capturedAt: number;
  localDate: string;
  seriesId: number;
  counters: SeasonalCounters;
}

export type IntervalStatus = "valid" | "reset" | "schema_anomaly";

export interface ProgressionIntervalRecord extends ProfileIdentity {
  id: number;
  fromSnapshotId: number;
  toSnapshotId: number;
  endedAt: number;
  localDate: string;
  elapsedDays: number;
  status: IntervalStatus;
  changes: SeasonalCounters;
  tempoScore: number | null;
  formScore: number | null;
  scoreSampleN: number | null;
  confidence: number;
  scoreVersion: number;
}

export type ProgressionKind = "cumulative" | "tempo" | "form";
export type CohortDimension = "hours" | "pmc_raids";
export type ProgressionMode = "regular" | "seasonal";

export interface DailyAggregateRecord {
  mode: ProgressionMode;
  cycleId: CycleId;
  localDate: string;
  kind: ProgressionKind;
  dimension: CohortDimension;
  bucketMin: number;
  bucketMax: number | null;
  mean: number;
  p25: number | null;
  p75: number | null;
  n: number;
  confidence: number;
  freshnessAt: number;
  scoreVersion: number;
}

export const LIFETIME_HOUR_BANDS = [
  [0, 50],
  [50, 100],
  [100, 200],
  [200, 500],
  [500, 1_000],
  [1_000, 2_000],
  [2_000, 5_000],
  [5_000, null],
] as const;

export type ScanTaskKind = "profile" | "linked_pvp" | "ban_check";
export type ScanTaskPriority = 1 | 2 | 3 | 4;
export type ScanTaskActor = "helper" | "operator";
export type ScanTaskState =
  | "queued"
  | "leased"
  | "completed"
  | "skipped"
  | "not_found"
  | "rate_limited"
  | "upstream_error"
  | "schema_error";

export interface ScanTaskRecord extends ProfileIdentity {
  id: number;
  kind: ScanTaskKind;
  priority: ScanTaskPriority;
  state: ScanTaskState;
  previousProfileUpdatedAt: number | null;
  leaseOwner: string | null;
  leasedUntil: number | null;
  attempts: number;
  availableAt: number;
}

export interface HelperSessionRecord {
  helperId: string;
  createdAt: number;
  lastSeenAt: number;
  pollingUntil: number;
}

export interface CaptureSnapshotResult {
  inserted: boolean;
  status: "baseline" | "progression" | "reset" | "schema_anomaly" | "duplicate" | "stale" | "banned";
  snapshot: ProgressionSnapshotRecord | null;
  interval: ProgressionIntervalRecord | null;
}

export interface ProgressionPoint {
  /** Stable source identity used by chart renderers. */
  pointId: string;
  date: string;
  observedAt: number | null;
  pmcRaids: number;
  /** Inclusive PMC-raid range for aggregate points; absent for exact player snapshots. */
  raidMin?: number;
  raidMax?: number;
  /** Optional interval details used by score tooltips. */
  periodStartAt?: number | null;
  elapsedDays?: number | null;
  deltaExperience?: number | null;
  deltaPmcRaids?: number | null;
  value: number;
  /** Present for player history so renderers can break the line across wipes. */
  seriesId: number | null;
  p25: number | null;
  p75: number | null;
  n: number;
  /** Score cohort size; null for cumulative points. */
  sampleN: number | null;
  /** True when a score is based on fewer than the stable cohort threshold. */
  preliminary: boolean;
  confidence: number;
}

export interface SeasonalPopulationFreshness {
  last24Hours: number;
  last72Hours: number;
  last7Days: number;
  older: number;
}

export interface SeasonalPopulationSummary {
  n: number;
  lifetimeBandCounts: number[];
  freshnessAt: number | null;
  freshness: SeasonalPopulationFreshness;
  averages: {
    experience: number | null;
    pmcRaids: number | null;
    scavRaids: number | null;
    pmcKills: number | null;
    killedPmc: number | null;
    pmcSurvivalRate: number | null;
  };
}

export interface SeasonalAverageSeries {
  kind: ProgressionKind;
  overall: ProgressionPoint[];
  n: number;
  confidence: number;
  freshnessAt: number | null;
}

export interface ProgressionAverageResponse {
  mode: "regular";
  cycleId: "persistent";
  axis: "pmc_raids";
  series: Record<ProgressionKind, SeasonalAverageSeries>;
}

export interface SeasonalAverageResponse {
  mode: "seasonal";
  cycleId: CycleId;
  population: SeasonalPopulationSummary;
  series: Record<ProgressionKind, SeasonalAverageSeries>;
}

export interface ProgressionSeriesResponse {
  identity: ProfileIdentity;
  kind: ProgressionKind;
  axis: "pmc_raids";
  player: ProgressionPoint[];
  nearby: ProgressionPoint[];
  overall: ProgressionPoint[];
  n: number;
  confidence: number;
  freshnessAt: number | null;
  history: {
    snapshotCount: number;
    allIntervalCount: number;
    changedIntervalCount: number;
    raidIntervalCount: number;
    tempoPointCount: number;
    formPointCount: number;
    /** Backward-compatible alias for changedIntervalCount. */
    intervalCount: number;
    ready: boolean;
    firstObservedAt: number | null;
    lastObservedAt: number | null;
  };
}

export interface SeasonalStore {
  getCycle(cycleId: CycleId): Promise<SeasonCycle | null>;
  upsertProfile(profile: SeasonalProfile, observedAt?: number): Promise<PlayerProfileRecord>;
  captureSnapshot(profile: SeasonalProfile, capturedAt?: number): Promise<CaptureSnapshotResult>;
  latestSnapshot(identity: ProfileIdentity): Promise<ProgressionSnapshotRecord | null>;
  snapshotHistory(identity: ProfileIdentity): Promise<ProgressionSnapshotRecord[]>;
  enqueueTask(input: ProfileIdentity & {
    kind: ScanTaskKind;
    priority: ScanTaskPriority;
    previousProfileUpdatedAt?: number | null;
    availableAt?: number;
    now?: number;
  }): Promise<ScanTaskRecord>;
  claimTasks(input: {
    mode: GameMode;
    cycleId: CycleId;
    actor: ScanTaskActor;
    owner: string;
    limit: number;
    now?: number;
  }): Promise<ScanTaskRecord[]>;
}

export function isGameMode(value: unknown): value is GameMode {
  return typeof value === "string" && GAME_MODES.includes(value as GameMode);
}

export function normalizeCycleId(value: unknown, mode: GameMode): CycleId | null {
  if (value == null || value === "") return mode === "seasonal" ? null : LEGACY_IDENTITY.cycleId;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(normalized) ? normalized : null;
}
