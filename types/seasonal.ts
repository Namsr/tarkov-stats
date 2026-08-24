import type { WeaponMasteryProgress } from "@/types/tarkov";

export const GAME_MODES = ["regular", "pve", "arena", "seasonal"] as const;

export type GameMode = (typeof GAME_MODES)[number];
export type CycleId = string;

/** The internal mode name stays stable even when Tarkov.dev uses another slug. */
export const SEASONAL_UPSTREAM_MODE = "pvp-season" as const;
/** Canonical public route slug for the internal Seasonal mode. */
export const SEASON_ROUTE_MODE = "pvp-season" as const;
export type SeasonalCollectionSource = "operator" | "json_feed";
export type SeasonalUpstreamContract = "game_mode" | "profile_section" | "direct_profile";

/** Maps an internal mode to the slug understood by Tarkov.dev URLs. */
export function tarkovDevMode(mode: GameMode): string {
  return mode === "seasonal" ? SEASONAL_UPSTREAM_MODE : mode;
}

/** Maps an internal mode to the public route used by this application. */
export function appRouteMode(mode: GameMode): string {
  return mode === "seasonal" ? SEASON_ROUTE_MODE : mode;
}

/** Parses only canonical public route slugs; internal and retired names are not aliases. */
export function gameModeFromAppRoute(value: unknown): GameMode | null {
  if (value === SEASON_ROUTE_MODE) return "seasonal";
  return value === "regular" || value === "pve" || value === "arena" ? value : null;
}

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
  upstreamContract: SeasonalUpstreamContract | null;
  /** Optional for backwards-compatible callers; configuration defaults to operator. */
  collectionSource?: SeasonalCollectionSource;
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
  /** Exact PMC-vs-PMC kills when the upstream counter is available. */
  pmcKilledPmc?: number;
}

/** Wipe-scoped portrait fields parsed from the Seasonal profile only. */
export interface SeasonalStats {
  totalRaids: number | null;
  survivedRaids: number | null;
  totalKills: number | null;
  deaths: number | null;
  runThrough: number | null;
  survivalRate: number | null;
  kdRatio: number | null;
  pmcKdRatio: number | null;
  killsPerRaid: number | null;
  pmcSurvivalRate: number | null;
  level: number | null;
  prestige: number | null;
  longestWinStreak: number | null;
  achievementsCount: number | null;
}

/** Explicitly allow-listed account-wide values used for Seasonal comparison. */
export interface SeasonalPvpEnrichment {
  lifetimeHours: number | null;
  achievementIds: string[];
  achievementCount: number | null;
  profileUpdatedAt: number | null;
}

/**
 * An achievement as captured from the Seasonal upstream profile.
 *
 * `unlockedAt: null` is intentional: old snapshots only stored the id and
 * must remain readable without inventing a date.
 */
export interface SeasonalAchievementUnlock {
  id: string;
  unlockedAt: number | null;
}

/**
 * The upstream `skills.Common` rows are retained as JSON.  Skill fields have
 * changed between wipes, so the storage boundary deliberately keeps unknown
 * fields instead of projecting a brittle fixed schema.
 */
export type SeasonalCommonSkill = Record<string, unknown>;

/** Runtime-validated representation produced by either supported upstream shape. */
export interface SeasonalProfile extends ProfileIdentity {
  nickname: string;
  /** Account side from the Seasonal profile, when the upstream includes it. */
  side?: string;
  profileUpdatedAt: number;
  lastAccessAt: number;
  lifetimePvpHours: number | null;
  counters: SeasonalCounters;
  /** null = the upstream payload was present but had no achievement data. */
  seasonalAchievements?: SeasonalAchievementUnlock[] | null;
  /** null = the upstream payload did not include a Common-skills array. */
  commonSkills?: SeasonalCommonSkill[] | null;
  /** null = the upstream payload did not include a Mastering-skills array. */
  weaponMastery?: WeaponMasteryProgress[] | null;
  seasonalStats?: SeasonalStats;
  pvpEnrichment?: SeasonalPvpEnrichment;
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
  /** Dual-read representation of the snapshot's own Seasonal achievements. */
  achievements: SeasonalAchievementUnlock[] | null;
  /** Latest raw upstream `skills.Common` JSON; old rows legitimately contain NULL. */
  commonSkills: SeasonalCommonSkill[] | null;
  /** Latest normalized upstream `skills.Mastering`; old rows legitimately contain NULL. */
  weaponMastery: WeaponMasteryProgress[] | null;
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
/** Modes backed by the persistent progression stream. */
export type PersistentProgressionMode = "regular" | "pve";
export type ProgressionMode = PersistentProgressionMode | "seasonal";

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
  /** Character level resolved from cumulative experience at this point. */
  level?: number | null;
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
  mode: ProgressionMode;
  cycleId: CycleId;
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

/** Individual lines available in the profile progression timeline. */
export type ProgressionMetricKey =
  | "xp"
  | "xp_per_day"
  | "pmc_raids_per_day"
  | "pmc_kills_per_day"
  | "non_pmc_kills_per_day"
  | "survival"
  | "pvp_kd"
  | "ai_kd"
  | "pmc_kills_per_raid"
  | "non_pmc_kills_per_raid";

export const PROGRESSION_METRIC_KEYS = [
  "xp",
  "xp_per_day",
  "pmc_raids_per_day",
  "pmc_kills_per_day",
  "non_pmc_kills_per_day",
  "survival",
  "pvp_kd",
  "ai_kd",
  "pmc_kills_per_raid",
  "non_pmc_kills_per_raid",
] as const satisfies readonly ProgressionMetricKey[];

export interface ProgressionMetricSeries {
  player: ProgressionPoint[];
  nearby: ProgressionPoint[];
  overall: ProgressionPoint[];
  n: number;
  confidence: number;
  freshnessAt: number | null;
}

/** One request payload for all selectable profile progression metrics. */
export interface ProgressionTimelineResponse {
  identity: ProfileIdentity;
  axis: "pmc_raids";
  /** Season/cycle start used as day zero for the optional calendar-time axis. */
  cycleStartsAt?: number | null;
  metrics: Partial<Record<ProgressionMetricKey, ProgressionMetricSeries>>;
  history: ProgressionSeriesResponse["history"];
  risk: import("@/lib/seasonal/progression-details").SeasonalRiskPayload;
  longTerm: import("@/lib/seasonal/progression-details").SeasonalLongTermPayload;
  n: number;
  confidence: number;
  freshnessAt: number | null;
  comparison: {
    status: "ready" | "warming";
    generation: number | null;
    generatedAt: number | null;
  };
}

export interface SeasonalStore {
  getCycle(cycleId: CycleId): Promise<SeasonCycle | null>;
  getProfile(identity: ProfileIdentity): Promise<PlayerProfileRecord | null>;
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
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(normalized)) return null;
  if (mode === "seasonal") return normalized === LEGACY_IDENTITY.cycleId ? null : normalized;
  if (mode === "regular" || mode === "pve") {
    return normalized === LEGACY_IDENTITY.cycleId ? LEGACY_IDENTITY.cycleId : null;
  }
  return normalized;
}

function normalizeSeasonalNavigationCycle(value: unknown): CycleId | null {
  const cycleId = normalizeCycleId(value, "seasonal");
  return cycleId === LEGACY_IDENTITY.cycleId ? null : cycleId;
}

export function seasonalCycleForNavigation(
  current: GameMode,
  suppliedCycleId: unknown,
  rememberedCycleId: unknown,
  urlCycleId: unknown,
): CycleId | null {
  const supplied = current === "seasonal"
    ? normalizeSeasonalNavigationCycle(suppliedCycleId)
    : null;
  return supplied ?? normalizeSeasonalNavigationCycle(rememberedCycleId) ??
    (current === "seasonal" ? normalizeSeasonalNavigationCycle(urlCycleId) : null);
}
