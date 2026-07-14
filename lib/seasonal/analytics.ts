import type { IntervalStatus, SeasonalCounters } from "@/types/seasonal";

export const ANALYTICS_SCORE_VERSION = 1;
export const DAY_MS = 86_400_000;

const COUNTER_KEYS = [
  "experience",
  "pmcRaids",
  "scavRaids",
  "pmcSurvived",
  "pmcDeaths",
  "pmcKills",
  "killedPmc",
] as const satisfies readonly (keyof SeasonalCounters)[];

export interface AnalyticsSnapshot {
  profileUpdatedAt: number;
  counters: SeasonalCounters;
}

export interface IntervalMetrics {
  xpPerDay: number;
  pmcRaidsPerDay: number;
  killedPmcPerDay: number;
  nonPmcKillsPerDay: number;
  survivalRate: number | null;
  pvpKd: number;
  aiScavKd: number;
  overallPmcKd: number;
  killedPmcPerRaid: number | null;
  nonPmcKillsPerRaid: number | null;
  xpPerPmcRaid: number | null;
  allPmcKillsPerRaid: number | null;
}

export interface AnalyticsInterval {
  from: AnalyticsSnapshot;
  to: AnalyticsSnapshot;
  elapsedDays: number;
  seriesId: number;
  status: IntervalStatus;
  changes: SeasonalCounters;
  changedFields: (keyof SeasonalCounters)[];
  negativeFields: (keyof SeasonalCounters)[];
  metrics: IntervalMetrics | null;
  hasTempo: boolean;
  hasForm: boolean;
  confidence: number;
  scoreVersion: number;
}

export type ConfidenceLabel = "low" | "medium" | "high";

export interface ConfidenceResult {
  value: number;
  label: ConfidenceLabel;
}

export interface CohortMember<T = unknown> {
  dimensionValue: number;
  value: T;
}

export interface ExpandedCohort<T = unknown> {
  tolerance: number;
  min: number;
  max: number;
  members: CohortMember<T>[];
}

export type TempoPercentiles = {
  xpPerDay: number;
  pmcRaidsPerDay: number;
  killedPmcPerDay: number;
  nonPmcKillsPerDay: number;
};

export type FormPercentiles = {
  survivalRate: number;
  pvpKd: number;
  aiScavKd: number;
  killedPmcPerRaid: number;
  nonPmcKillsPerRaid: number;
};

export type AnomalyMetric =
  | "killedPmcPerRaid"
  | "pvpKd"
  | "survivalRate"
  | "xpPerPmcRaid"
  | "allPmcKillsPerRaid"
  | "pmcRaidsPerDay";

export type AnomalyPercentiles = Record<AnomalyMetric, number>;

export interface IntervalAnomalyResult {
  score: number;
  reasons: { metric: AnomalyMetric; percentile: number; contribution: number }[];
  scoreVersion: number;
}

export interface CombinedRiskResult {
  score: number;
  tier: "low" | "medium" | "high" | "severe";
  staticContribution: number;
  progressionContribution: number;
  progressionWeight: number;
  confidence: ConfidenceResult;
  reasons: IntervalAnomalyResult["reasons"];
  scoreVersion: number;
}

const TEMPO_WEIGHTS: Record<keyof TempoPercentiles, number> = {
  xpPerDay: 0.55,
  pmcRaidsPerDay: 0.15,
  killedPmcPerDay: 0.15,
  nonPmcKillsPerDay: 0.15,
};

const FORM_WEIGHTS: Record<keyof FormPercentiles, number> = {
  survivalRate: 0.25,
  pvpKd: 0.25,
  aiScavKd: 0.15,
  killedPmcPerRaid: 0.25,
  nonPmcKillsPerRaid: 0.1,
};

const ANOMALY_WEIGHTS: Record<AnomalyMetric, number> = {
  killedPmcPerRaid: 0.25,
  pvpKd: 0.25,
  survivalRate: 0.15,
  xpPerPmcRaid: 0.15,
  allPmcKillsPerRaid: 0.1,
  pmcRaidsPerDay: 0.1,
};

const COHORT_TOLERANCES = [0.1, 0.15, 0.2, 0.25, 0.3] as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function stableDecimal(value: number): number {
  return Math.round(value * 1e12) / 1e12;
}

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
}

function zeroCounters(): SeasonalCounters {
  return {
    experience: 0,
    pmcRaids: 0,
    scavRaids: 0,
    pmcSurvived: 0,
    pmcDeaths: 0,
    pmcKills: 0,
    killedPmc: 0,
  };
}

function kd(kills: number, deaths: number): number {
  return deaths === 0 ? kills : kills / deaths;
}

export function calculateKd(changes: SeasonalCounters): Pick<
  IntervalMetrics,
  "pvpKd" | "aiScavKd" | "overallPmcKd"
> {
  const nonPmcKills = changes.pmcKills - changes.killedPmc;
  return {
    pvpKd: kd(changes.killedPmc, changes.pmcDeaths),
    aiScavKd: kd(nonPmcKills, changes.pmcDeaths),
    overallPmcKd: kd(changes.pmcKills, changes.pmcDeaths),
  };
}

export function intervalConfidence(elapsedDays: number): number {
  assertFinite(elapsedDays, "elapsedDays");
  if (elapsedDays <= 0) return 0;
  return elapsedDays <= 1 ? 1 : 1 / elapsedDays;
}

export function progressionConfidence(
  intervalCount: number,
  newPmcRaids: number,
  elapsedDays = 1
): ConfidenceResult {
  const intervals = Math.max(0, intervalCount);
  const raids = Math.max(0, newPmcRaids);
  const evidence = Math.min(intervals / 3, raids / 20, 1);
  const value = clamp(evidence * intervalConfidence(elapsedDays), 0, 1);
  const label: ConfidenceLabel =
    intervals >= 3 && raids >= 20 && elapsedDays <= 1
      ? "high"
      : value >= 0.5
        ? "medium"
        : "low";
  return { value, label };
}

export function buildSequentialIntervals(
  snapshots: readonly AnalyticsSnapshot[]
): AnalyticsInterval[] {
  const unique = new Map<number, AnalyticsSnapshot>();
  for (const snapshot of snapshots) {
    assertFinite(snapshot.profileUpdatedAt, "profileUpdatedAt");
    if (!unique.has(snapshot.profileUpdatedAt)) unique.set(snapshot.profileUpdatedAt, snapshot);
  }
  const ordered = [...unique.values()].sort((a, b) => a.profileUpdatedAt - b.profileUpdatedAt);
  const intervals: AnalyticsInterval[] = [];
  let seriesId = 1;

  for (let index = 1; index < ordered.length; index += 1) {
    const from = ordered[index - 1];
    const to = ordered[index];
    const elapsedDays = (to.profileUpdatedAt - from.profileUpdatedAt) / DAY_MS;
    const changes = zeroCounters();
    const changedFields: (keyof SeasonalCounters)[] = [];
    const negativeFields: (keyof SeasonalCounters)[] = [];
    for (const key of COUNTER_KEYS) {
      const change = to.counters[key] - from.counters[key];
      changes[key] = change;
      if (change !== 0) changedFields.push(key);
      if (change < 0) negativeFields.push(key);
    }

    // A broad fall of the primary progression counters is a wipe/reset. An isolated
    // negative cumulative field is treated as a schema anomaly; both start a new series.
    const primaryReset = changes.experience < 0 && changes.pmcRaids < 0;
    const status: IntervalStatus = negativeFields.length
      ? primaryReset
        ? "reset"
        : "schema_anomaly"
      : elapsedDays > 0
        ? "valid"
        : "schema_anomaly";

    let metrics: IntervalMetrics | null = null;
    if (status === "valid") {
      const nonPmcKills = changes.pmcKills - changes.killedPmc;
      const kdValues = calculateKd(changes);
      metrics = {
        xpPerDay: changes.experience / elapsedDays,
        pmcRaidsPerDay: changes.pmcRaids / elapsedDays,
        killedPmcPerDay: changes.killedPmc / elapsedDays,
        nonPmcKillsPerDay: nonPmcKills / elapsedDays,
        survivalRate: changes.pmcRaids > 0 ? changes.pmcSurvived / changes.pmcRaids : null,
        ...kdValues,
        killedPmcPerRaid: changes.pmcRaids > 0 ? changes.killedPmc / changes.pmcRaids : null,
        nonPmcKillsPerRaid: changes.pmcRaids > 0 ? nonPmcKills / changes.pmcRaids : null,
        xpPerPmcRaid: changes.pmcRaids > 0 ? changes.experience / changes.pmcRaids : null,
        allPmcKillsPerRaid: changes.pmcRaids > 0 ? changes.pmcKills / changes.pmcRaids : null,
      };
    }

    intervals.push({
      from,
      to,
      elapsedDays,
      seriesId,
      status,
      changes,
      changedFields,
      negativeFields,
      metrics,
      hasTempo: status === "valid" && changedFields.length > 0,
      hasForm: status === "valid" && changes.pmcRaids > 0,
      confidence: status === "valid" ? intervalConfidence(elapsedDays) : 0,
      scoreVersion: ANALYTICS_SCORE_VERSION,
    });
    if (status !== "valid") seriesId += 1;
  }
  return intervals;
}

/** Percentile rank with average ranks for ties, mapped to endpoints 0 and 100. */
export function percentileRank(value: number, population: readonly number[]): number | null {
  assertFinite(value, "value");
  const values = population.filter(Number.isFinite).sort((a, b) => a - b);
  if (values.length === 0) return null;
  if (values.length === 1) return 50;
  let below = 0;
  let equal = 0;
  for (const candidate of values) {
    if (candidate < value) below += 1;
    else if (candidate === value) equal += 1;
  }
  const averageZeroBasedRank = below + Math.max(0, equal - 1) / 2;
  return clamp((averageZeroBasedRank / (values.length - 1)) * 100, 0, 100);
}

function weightedScore<T extends Record<string, number>>(values: T, weights: Record<keyof T, number>): number {
  let score = 0;
  for (const key of Object.keys(weights) as (keyof T)[]) {
    score += clamp(values[key], 0, 100) * weights[key];
  }
  return stableDecimal(score);
}

export function tempoScore(percentiles: TempoPercentiles): number {
  return weightedScore(percentiles, TEMPO_WEIGHTS);
}

export function formScore(percentiles: FormPercentiles): number {
  return weightedScore(percentiles, FORM_WEIGHTS);
}

export function trimmedMean(values: readonly number[], trimFraction = 0.05): number | null {
  if (!(trimFraction >= 0 && trimFraction < 0.5)) {
    throw new RangeError("trimFraction must be between 0 and 0.5");
  }
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const trimCount = Math.floor(sorted.length * trimFraction);
  const kept = sorted.slice(trimCount, sorted.length - trimCount);
  return kept.reduce((sum, value) => sum + value, 0) / kept.length;
}

export function quantile(values: readonly number[], probability: number): number | null {
  if (!(probability >= 0 && probability <= 1)) throw new RangeError("probability must be 0..1");
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return sorted[lower] + (sorted[lower + 1] - sorted[lower] || 0) * fraction;
}

export function expandNearbyCohort<T>(
  center: number,
  candidates: readonly CohortMember<T>[],
  minimum = 30
): ExpandedCohort<T> | null {
  assertFinite(center, "center");
  if (!Number.isInteger(minimum) || minimum <= 0) throw new RangeError("minimum must be positive");
  for (const tolerance of COHORT_TOLERANCES) {
    const radius = Math.abs(center) * tolerance;
    const min = center - radius;
    const max = center + radius;
    const members = candidates.filter(
      (candidate) =>
        Number.isFinite(candidate.dimensionValue) &&
        candidate.dimensionValue >= min &&
        candidate.dimensionValue <= max
    );
    if (members.length >= minimum) return { tolerance, min, max, members };
  }
  return null;
}

/** Combines eight per-band series using the large-base distribution, not panel quotas. */
export function weightedEightBandMean(
  bandValues: readonly (readonly number[])[],
  distribution: readonly number[]
): number | null {
  if (bandValues.length !== 8 || distribution.length !== 8) {
    throw new RangeError("exactly eight lifetime bands are required");
  }
  let weighted = 0;
  let totalWeight = 0;
  for (let index = 0; index < 8; index += 1) {
    const weight = distribution[index];
    assertFinite(weight, `distribution[${index}]`);
    if (weight < 0) throw new RangeError("distribution weights cannot be negative");
    if (weight === 0) continue;
    const mean = trimmedMean(bandValues[index]);
    if (mean == null) return null;
    weighted += mean * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? weighted / totalWeight : null;
}

export function percentileRisk(percentile: number): number {
  assertFinite(percentile, "percentile");
  return clamp((percentile - 95) / 5, 0, 1);
}

export function intervalAnomaly(percentiles: AnomalyPercentiles): IntervalAnomalyResult {
  let score = 0;
  const reasons: IntervalAnomalyResult["reasons"] = [];
  for (const metric of Object.keys(ANOMALY_WEIGHTS) as AnomalyMetric[]) {
    const percentile = clamp(percentiles[metric], 0, 100);
    const contribution = percentileRisk(percentile) * ANOMALY_WEIGHTS[metric];
    score += contribution;
    if (contribution > 0) reasons.push({ metric, percentile, contribution });
  }
  reasons.sort((a, b) => b.contribution - a.contribution);
  return { score, reasons, scoreVersion: ANALYTICS_SCORE_VERSION };
}

export function progressionRisk(anomalies: readonly number[]): number | null {
  const latest = anomalies.slice(-14).filter(Number.isFinite).map((value) => clamp(value, 0, 1));
  if (latest.length === 0) return null;
  const top = latest.sort((a, b) => b - a).slice(0, 3);
  const maximum = top[0];
  const topThreeMean = top.reduce((sum, value) => sum + value, 0) / top.length;
  return 0.7 * maximum + 0.3 * topThreeMean;
}

function tierFor(score: number): CombinedRiskResult["tier"] {
  if (score < 20) return "low";
  if (score < 45) return "medium";
  if (score < 70) return "high";
  return "severe";
}

export function combineCheaterRisk(input: {
  staticScore: number;
  intervalAnomalies: readonly IntervalAnomalyResult[];
  intervalCount: number;
  newPmcRaids: number;
  elapsedDays?: number;
}): CombinedRiskResult {
  const staticScore = clamp(input.staticScore, 0, 100);
  const confidence = progressionConfidence(
    input.intervalCount,
    input.newPmcRaids,
    input.elapsedDays ?? 1
  );
  const risk = progressionRisk(input.intervalAnomalies.map((anomaly) => anomaly.score));
  const progressionWeight = risk == null ? 0 : stableDecimal(0.6 * confidence.value);
  const staticContribution = staticScore * (1 - progressionWeight);
  const progressionContribution = (risk ?? 0) * 100 * progressionWeight;
  const score = Math.round(clamp(staticContribution + progressionContribution, 0, 100));
  const reasons = input.intervalAnomalies
    .slice(-14)
    .flatMap((anomaly) => anomaly.reasons)
    .sort((a, b) => b.contribution - a.contribution);
  return {
    score,
    tier: tierFor(score),
    staticContribution,
    progressionContribution,
    progressionWeight,
    confidence,
    reasons,
    scoreVersion: ANALYTICS_SCORE_VERSION,
  };
}
