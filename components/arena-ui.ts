import type { ParsedPlayerStats } from "@/types/tarkov";
import {
  ARENA_METRIC_KEYS,
  ARENA_MODE_KEYS,
  type ArenaAverageResult,
  type ArenaCohortResult,
  type ArenaCounters,
  type ArenaMetricKey,
  type ArenaMetrics,
  type ArenaModeKey,
  type ArenaModeStats,
  type ArenaOverallStats,
  type ArenaProfile,
  type ArenaStatistic,
} from "@/types/arena";

export { ARENA_METRIC_KEYS, ARENA_MODE_KEYS };
export type { ArenaMetricKey, ArenaModeKey };

export type ArenaCardStats = ParsedPlayerStats | ArenaProfile | null;

export interface ArenaAveragePopulation {
  scannedAccounts: number;
  playedAccounts: Record<ArenaModeKey, number>;
}

export const ARENA_METRIC_DECIMALS: Record<ArenaMetricKey, number> = {
  kd_ratio: 2,
  win_rate: 1,
  headshot_rate: 1,
  kills_per_match: 2,
  damage_per_match: 0,
};

export function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return null;
  const number = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

export function formatArenaValue(value: number | null | undefined, metric?: ArenaMetricKey): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const decimals = metric ? ARENA_METRIC_DECIMALS[metric] : 0;
  return value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatArenaMetric(value: number | null | undefined, metric: ArenaMetricKey): string {
  const formatted = formatArenaValue(value, metric);
  return value == null || !Number.isFinite(value)
    ? formatted
    : metric === "win_rate" || metric === "headshot_rate"
      ? `${formatted}%`
      : formatted;
}

function nullableFields<T extends readonly string[]>(value: unknown, fields: T): Record<T[number], number | null> {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return Object.fromEntries(fields.map((field) => [field, finiteNumber(source[field])])) as Record<T[number], number | null>;
}

export function emptyArenaCounters(): ArenaCounters {
  return {
    matches: null,
    wins: null,
    losses: null,
    kills: null,
    deaths: null,
    assists: null,
    headshots: null,
    damage: null,
    round_mvp: null,
    match_mvp: null,
    current_kill_streak: null,
    max_kill_streak: null,
    current_win_streak: null,
    max_win_streak: null,
    current_loss_streak: null,
    max_loss_streak: null,
  };
}

export function emptyArenaMetrics(): ArenaMetrics {
  return Object.fromEntries(ARENA_METRIC_KEYS.map((key) => [key, null])) as ArenaMetrics;
}

export function normalizeArenaCounters(value: unknown): ArenaCounters {
  return {
    ...emptyArenaCounters(),
    ...nullableFields(value, [
      "matches",
      "wins",
      "losses",
      "kills",
      "deaths",
      "assists",
      "headshots",
      "damage",
      "round_mvp",
      "match_mvp",
      "current_kill_streak",
      "max_kill_streak",
      "current_win_streak",
      "max_win_streak",
      "current_loss_streak",
      "max_loss_streak",
    ] as const),
  };
}

export function normalizeArenaMetrics(value: unknown): ArenaMetrics {
  return {
    ...emptyArenaMetrics(),
    ...nullableFields(value, ARENA_METRIC_KEYS),
  };
}

function normalizeMode(value: unknown, mode: ArenaModeKey): ArenaModeStats {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    mode,
    hours: finiteNumber(source.hours),
    counters: normalizeArenaCounters(source.counters),
    metrics: normalizeArenaMetrics(source.metrics),
  };
}

function normalizeOverall(value: unknown): ArenaOverallStats {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const sourceName = source.source;
  const sourceValue: ArenaOverallStats["source"] =
    sourceName === "upstream" || sourceName === "complete_mode_sum" ? sourceName : "unavailable";
  return {
    hours: finiteNumber(source.hours),
    counters: normalizeArenaCounters(source.counters),
    metrics: normalizeArenaMetrics(source.metrics),
    bestArp: finiteNumber(source.bestArp),
    source: sourceValue,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function looksLikeArenaProfile(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const modes = value.modes;
  return isRecord(modes) && ARENA_MODE_KEYS.some((mode) => isRecord(modes[mode]));
}

function looksLikeNormalizedArenaProfile(value: unknown): value is Record<string, unknown> {
  if (!looksLikeArenaProfile(value) || !isRecord(value.overall)) return false;
  return isRecord(value.overall.counters) && isRecord(value.overall.metrics) &&
    "profileUpdatedAt" in value && "parserVersion" in value;
}

function fromNormalizedProfile(value: Record<string, unknown>, fallbackAid: number): ArenaProfile {
  const modes = isRecord(value.modes) ? value.modes : {};
  const fallbackNickname = isRecord(value.info) ? value.info.nickname : undefined;
  const nickname = String(value.nickname ?? fallbackNickname ?? "").trim();
  return {
    aid: finiteNumber(value.aid) ?? fallbackAid,
    nickname,
    profileUpdatedAt: finiteNumber(value.profileUpdatedAt ?? value.updated) ?? 0,
    fetchedAt: finiteNumber(value.fetchedAt),
    parserVersion: finiteNumber(value.parserVersion) ?? 0,
    overall: normalizeOverall(value.overall),
    modes: Object.fromEntries(ARENA_MODE_KEYS.map((mode) => [mode, normalizeMode(modes[mode], mode)])) as Record<ArenaModeKey, ArenaModeStats>,
  };
}

function legacyModeKey(value: unknown): ArenaModeKey | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[-_\s]/g, "").toLowerCase();
  if (normalized === "teamfight") return "teamFight";
  if (normalized === "lasthero") return "lastHero";
  if (normalized === "checkpoint") return "checkpoint";
  if (normalized === "blastgang") return "blastGang";
  if (normalized === "shootoutduo") return "shootOutDuo";
  return null;
}

function fromLegacyArena(
  value: unknown,
  fallbackAid: number,
  nickname: string,
  profileUpdatedAt: number,
  hours: number | null,
): ArenaProfile | null {
  if (!isRecord(value) || !Array.isArray(value.modes)) return null;
  const modes = Object.fromEntries(ARENA_MODE_KEYS.map((mode) => [mode, normalizeMode(undefined, mode)])) as Record<ArenaModeKey, ArenaModeStats>;
  for (const item of value.modes) {
    if (!isRecord(item)) continue;
    const mode = legacyModeKey(item.key ?? item.mode);
    if (!mode) continue;
    const kills = finiteNumber(item.kills);
    const deaths = finiteNumber(item.deaths);
    const kdRatio = finiteNumber(item.kdRatio);
    const counters = emptyArenaCounters();
    counters.kills = kills;
    counters.deaths = deaths;
    counters.max_kill_streak = finiteNumber(item.maxKillStreak);
    counters.round_mvp = finiteNumber(item.roundMvp);
    counters.match_mvp = finiteNumber(item.matchMvp);
    counters.max_win_streak = finiteNumber(item.maxWinStreak);
    modes[mode] = {
      mode,
      hours: null,
      counters,
      metrics: {
        ...emptyArenaMetrics(),
        kd_ratio: kdRatio,
      },
    };
  }

  const totalKills = finiteNumber(value.totalKills);
  const totalDeaths = finiteNumber(value.totalDeaths);
  return {
    aid: fallbackAid,
    nickname,
    profileUpdatedAt,
    fetchedAt: null,
    parserVersion: 0,
    overall: {
      hours,
      bestArp: finiteNumber(value.bestArp),
      source: totalKills !== null || totalDeaths !== null ? "upstream" : "unavailable",
      counters: {
        ...emptyArenaCounters(),
        kills: totalKills,
        deaths: totalDeaths,
      },
      metrics: {
        ...emptyArenaMetrics(),
        kd_ratio: finiteNumber(value.kdRatio) ?? (totalKills !== null && totalDeaths !== null && totalDeaths > 0 ? totalKills / totalDeaths : null),
      },
    },
    modes,
  };
}

/**
 * Accepts the current Arena DTO and the old ParsedPlayerStats arena envelope.
 * The legacy path only copies values that existed upstream and leaves every
 * other counter null, so missing data never becomes a false zero.
 */
export function toArenaProfile(value: unknown, fallbackAid: number): ArenaProfile | null {
  if (!isRecord(value)) return null;
  const wrapper = value;
  const candidates: unknown[] = [
    wrapper.arena,
    wrapper.arenaProfile,
    wrapper.profile,
    wrapper.stats,
    wrapper,
  ];
  const responseNickname =
    (typeof wrapper.nickname === "string" ? wrapper.nickname : "") ||
    (isRecord(wrapper.profile) && typeof wrapper.profile.nickname === "string" ? wrapper.profile.nickname : "") ||
    (isRecord(wrapper.stats) && typeof wrapper.stats.nickname === "string" ? wrapper.stats.nickname : "");
  const responseUpdatedAt = finiteNumber(wrapper.profileUpdatedAt ?? wrapper.updated) ?? 0;
  const responseHours = finiteNumber(wrapper.hoursPlayed);

  for (const candidate of candidates) {
    if (looksLikeArenaProfile(candidate)) {
      const profile = fromNormalizedProfile(candidate, fallbackAid);
      return {
        ...profile,
        aid: profile.aid || fallbackAid,
        nickname: profile.nickname || responseNickname,
        profileUpdatedAt: profile.profileUpdatedAt || responseUpdatedAt,
        fetchedAt: profile.fetchedAt ?? finiteNumber(isRecord(wrapper.freshness) ? wrapper.freshness.fetchedAt : wrapper.fetchedAt),
        overall: profile.overall.hours === null && responseHours !== null
          ? { ...profile.overall, hours: responseHours }
          : profile.overall,
      };
    }
  }

  const legacy = candidates
    .map((candidate) => fromLegacyArena(
      candidate,
      fallbackAid,
      responseNickname,
      responseUpdatedAt,
      responseHours,
    ))
    .find((candidate): candidate is ArenaProfile => candidate !== null);
  return legacy ?? null;
}

export function isArenaProfile(value: unknown): value is ArenaProfile {
  return looksLikeNormalizedArenaProfile(value);
}

export function arenaMetricValue(value: ArenaModeStats | ArenaOverallStats | null | undefined, metric: ArenaMetricKey): number | null {
  return value?.metrics?.[metric] ?? null;
}

/**
 * Логарифмическая позиция бара, как в шестиугольнике (regular + ArenaRadar):
 * средний (ratio=1) ровно 50%, большие значения сжимаются и никогда не упираются в 100%.
 * 2× ≈69%, 10× ≈87%. Совпадает с homeRadarRatio*100.
 */
export function arenaBarPositionFromRatio(ratio: number | null | undefined): number | null {
  if (ratio == null || !Number.isFinite(ratio)) return null;
  if (ratio <= 0) return 0;
  const position = (0.5 + Math.atan(Math.log(ratio)) / Math.PI) * 100;
  return Math.max(0, Math.min(100, position));
}

export function arenaBarPosition(value: number | null | undefined, baseline: number | null | undefined): number | null {
  if (value == null || baseline == null || !Number.isFinite(value) || !Number.isFinite(baseline) || baseline <= 0) return null;
  if (value <= 0) return 0;
  return arenaBarPositionFromRatio(value / baseline);
}

export function arenaCounterValue(value: ArenaModeStats | ArenaOverallStats | null | undefined, key: keyof ArenaCounters): number | null {
  return value?.counters?.[key] ?? null;
}

function looksLikeAverage(value: unknown): value is ArenaAverageResult {
  return isRecord(value) && isRecord(value.metrics) && Array.isArray(value.buckets) && "sampleN" in value;
}

/** Population is optional for old cached responses, but never coerced to zero. */
export function arenaAveragePopulation(value: unknown): ArenaAveragePopulation | null {
  if (!isRecord(value) || !isRecord(value.population)) return null;
  const scannedAccounts = value.population.scannedAccounts;
  if (typeof scannedAccounts !== "number" || !Number.isSafeInteger(scannedAccounts) || scannedAccounts < 0 || !isRecord(value.population.playedAccounts)) return null;
  const playedAccounts = {} as Record<ArenaModeKey, number>;
  for (const mode of ARENA_MODE_KEYS) {
    const count = value.population.playedAccounts[mode];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return null;
    playedAccounts[mode] = count;
  }
  return { scannedAccounts, playedAccounts };
}

export function toArenaAverage(value: unknown): ArenaAverageResult | null {
  if (!isRecord(value)) return null;
  const candidates = [value.arenaAverage, value.average, value.result, value.data, value];
  return candidates.find(looksLikeAverage) ?? null;
}

/**
 * Validates a published or dynamic /api/average payload before it is shown as a
 * population cohort. Only the unfiltered whole-population variant qualifies: a
 * non-null range in `filterIdentity` describes a narrower slice and must not be
 * presented as the Arena-wide comparison.
 *
 * `bounds.matches.min` mirrors the eligibility floor `games_count >= 10` from
 * `arenaWhere({ eligible: true })` in lib/arena/service.ts; keep the two in sync.
 */
export function toArenaPopulationCohort(
  value: unknown,
  aid: number,
  mode: ArenaModeKey,
  statistic: ArenaStatistic,
  schemaVersion: unknown,
): ArenaCohortResult | null {
  const average = toArenaAverage(value);
  const identity = average?.filterIdentity;
  if (!isRecord(value) || value.mode !== "arena" ||
      typeof schemaVersion !== "number" || !Number.isSafeInteger(schemaVersion) || value.schemaVersion !== schemaVersion ||
      !average || !identity || identity.mode !== mode || identity.statistic !== statistic ||
      identity.dimension !== "matches" || identity.metric !== "players" ||
      identity.minHours !== null || identity.maxHours !== null ||
      identity.minMatches !== null || identity.maxMatches !== null ||
      !Number.isSafeInteger(average.sampleN) || average.sampleN < 0 ||
      !ARENA_METRIC_KEYS.every((metric) => {
        const item = average.metrics[metric];
        return isRecord(item) && (item.value === null || typeof item.value === "number" && Number.isFinite(item.value)) &&
          typeof item.count === "number" && Number.isSafeInteger(item.count) && item.count >= 0 &&
          (item.reason === null || item.reason === "no_valid_values" || item.reason === "insufficient_values");
      })) return null;
  return {
    aid,
    mode,
    strategy: "population",
    statistic,
    target: { hours: null, matches: null },
    percent: 30,
    bounds: { hours: { min: null, max: null }, matches: { min: 10, max: null } },
    sampleN: average.sampleN,
    required: 20,
    quality: average.sampleN >= 20 ? "sufficient" : "unavailable",
    reason: average.sampleN >= 20 ? null : "insufficient_cohort",
    metrics: average.metrics,
    averageMatches: readAverageMatches(average),
  };
}

/** Старые кэши/публикации могут не иметь averageMatches — тогда null, без падения. */
export function readAverageMatches(value: { averageMatches?: unknown } | null | undefined): ArenaCohortResult["averageMatches"] {
  if (!value || typeof value !== "object") return null;
  const item = (value as Record<string, unknown>).averageMatches;
  if (!isRecord(item)) return null;
  const rawValue = (item as Record<string, unknown>).value;
  const rawCount = (item as Record<string, unknown>).count;
  const parsedValue = typeof rawValue === "number" && Number.isFinite(rawValue) && rawValue >= 0 ? rawValue : null;
  const parsedCount = typeof rawCount === "number" && Number.isSafeInteger(rawCount) && rawCount >= 0 ? rawCount : 0;
  if (parsedValue == null && parsedCount === 0) return null;
  return { value: parsedValue, count: parsedCount, reason: parsedValue != null && parsedCount >= 20 ? null : parsedCount === 0 ? "no_valid_values" : "insufficient_values" };
}

/** Базовое число матчей для вкладки "Матчи": значение когорты, если достаточно данных. */
export function arenaCohortMatchesBaseline(cohort: ArenaCohortResult | null): number | null {
  if (!cohort || cohort.quality !== "sufficient") return null;
  const required = Math.max(20, cohort.required ?? 20);
  if (cohort.sampleN < required) return null;
  const item = readAverageMatches(cohort);
  if (!item || item.value == null || !(item.value > 0) || item.count < 20) return null;
  return item.value;
}

export async function loadArenaPopulationCohort(
  aid: number,
  mode: ArenaModeKey,
  statistic: ArenaStatistic,
  schemaVersion: unknown,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<ArenaCohortResult | null> {
  const query = new URLSearchParams({ mode: "arena", arenaMode: mode, statistic, publicationOnly: "1" });
  try {
    const response = await fetchImpl(`/api/average?${query}`, { signal });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    return toArenaPopulationCohort(body, aid, mode, statistic, schemaVersion);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return null;
  }
}

export function shouldFallbackToPopulation(cohort: ArenaCohortResult): boolean {
  if (cohort.quality === "sufficient" && cohort.sampleN >= Math.max(20, cohort.required)) return false;
  return cohort.reason === "insufficient_cohort";
}

/**
 * Per-mode baseline for the kd_ratio/winrate mode bars: the matched (or
 * population-fallback) cohort mean. Zero/negative means no marker on purpose:
 * a bar position is a ratio against the baseline and is undefined there.
 */
export function arenaMetricBaseline(cohort: ArenaCohortResult | null, metric: "kd_ratio" | "win_rate"): number | null {
  if (!cohort || cohort.quality !== "sufficient") return null;
  const required = Math.max(20, cohort.required ?? 20);
  if (cohort.sampleN < required) return null;
  const item = cohort.metrics[metric];
  if (!item || item.value == null || !(item.value > 0) || item.count < 20) return null;
  return item.value;
}

export type ArenaModeBaselinesPurpose = "matches" | "comparison";

export interface ArenaModeBaselines {
  cohorts: Partial<Record<ArenaModeKey, ArenaCohortResult | null>>;
  /** Modes the batch had no cohort for (publication warming, target missing). */
  unavailable: ArenaModeKey[];
}

/**
 * All five per-mode cohorts in ONE request. Replaces the 5×cohort (+5×fallback)
 * fan-out in ArenaModeBars: the server resolves matched→population fallback
 * inline, so the worst case drops from ~10 HTTP round-trips to 1.
 */
export async function loadArenaModeBaselines(
  aid: number,
  statistic: ArenaStatistic,
  purpose: ArenaModeBaselinesPurpose,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<ArenaModeBaselines> {
  const query = new URLSearchParams({ mode: "arena", aid: String(aid), statistic, purpose });
  const response = await fetchImpl(`/api/average/cohort/batch?${query}`, { signal });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error("baselines");
  const raw = isRecord(body) && isRecord(body.cohorts) ? body.cohorts : null;
  if (!raw) throw new Error("baselines");
  const cohorts: Partial<Record<ArenaModeKey, ArenaCohortResult | null>> = {};
  const unavailable: ArenaModeKey[] = [];
  for (const mode of ARENA_MODE_KEYS) {
    const cohort = toArenaCohort(raw[mode]);
    cohorts[mode] = cohort;
    if (!cohort) unavailable.push(mode);
  }
  return { cohorts, unavailable };
}

function looksLikeCohort(value: unknown): value is ArenaCohortResult {
  return isRecord(value) && isRecord(value.metrics) && isRecord(value.target) && "sampleN" in value;
}

export function toArenaCohort(value: unknown): ArenaCohortResult | null {
  if (!isRecord(value)) return null;
  const candidates = [value.arenaCohort, value.cohort, value.result, value.data, value];
  return candidates.find(looksLikeCohort) ?? null;
}

export function parsedStats(value: ArenaCardStats): ParsedPlayerStats | null {
  return value && !isArenaProfile(value) ? value : null;
}
