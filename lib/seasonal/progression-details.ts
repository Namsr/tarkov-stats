import type { IntervalStatus, ProgressionMode, SeasonalCounters } from "@/types/seasonal";
import {
  DAY_MS,
  buildSequentialIntervals,
  combineCheaterRisk,
  intervalAnomaly,
  percentileRank,
  progressionRisk,
  type AnomalyMetric,
  type AnomalyPercentiles,
  type IntervalAnomalyResult,
  type IntervalMetrics,
// @ts-expect-error Node's strip-types test runner requires the extension; Next accepts it.
} from "./analytics.ts";

export type ProgressionRiskReason =
  | "pmc_kills_per_raid"
  | "pvp_kd"
  | "survival_rate"
  | "xp_per_pmc_raid"
  | "all_kills_per_pmc_raid"
  | "pmc_raids_per_day";

/**
 * Database-neutral interval DTO. SQLite and D1 adapters should map their rows to
 * this shape after restricting the query to one cycle, `mode = 'seasonal'`, and
 * non-banned profiles. `localDate` is the Moscow date persisted with the interval.
 */
export interface ProgressionDetailIntervalRow {
  mode: ProgressionMode;
  cycleId: string;
  aid: number;
  localDate: string;
  endedAt: number;
  elapsedDays: number;
  status: IntervalStatus;
  changes: SeasonalCounters;
}

export interface ProgressionRiskMarker {
  /** Exact interval endpoint used to bind the marker to a plotted point. */
  endedAt: number;
  date: string;
  score: number;
  reasons: ProgressionRiskReason[];
}

/** Compatible with the optional `risk` payload consumed by SeasonalPlayer. */
export interface SeasonalRiskPayload {
  combined: number;
  static: number;
  progression: number | null;
  confidence: { value: number; tier: "low" | "medium" | "high" };
  staticContribution: number;
  progressionContribution: number;
  staticReasons: string[];
  reasons: ProgressionRiskReason[];
  markers: ProgressionRiskMarker[];
}

/** Compatible with the optional `longTerm` payload consumed by SeasonalPlayer. */
export interface SeasonalLongTermPayload {
  xpPerDay: number | null;
  raidsPerDay: number | null;
  pmcKillsPerDay: number | null;
  pmcKillsPerRaid: number | null;
  nonPmcKillsPerDay: number | null;
  nonPmcKillsPerRaid: number | null;
  survivalRate: number | null;
  pvpKd: number | null;
  aiKd: number | null;
  overallPmcKd: number | null;
  intervals: number;
  coveredRaids: number;
}

export interface SeasonalProgressionDetails {
  risk: SeasonalRiskPayload;
  longTerm: SeasonalLongTermPayload;
}

export interface BuildSeasonalProgressionDetailsInput {
  mode?: ProgressionMode;
  cycleId: string;
  aid: number;
  /** Must be calculated by trusted server code; it is never accepted from a client request. */
  trustedStaticScore: number;
  /** Factor keys from the trusted existing single-profile score. */
  staticReasons?: readonly string[];
  /** All candidate rows for the cycle, not only rows belonging to the requested player. */
  intervals: readonly ProgressionDetailIntervalRow[];
}

interface ScoredInterval {
  row: ProgressionDetailIntervalRow;
  metrics: IntervalMetrics;
  anomaly: IntervalAnomalyResult;
}

const REASON_BY_METRIC: Record<AnomalyMetric, ProgressionRiskReason> = {
  killedPmcPerRaid: "pmc_kills_per_raid",
  pvpKd: "pvp_kd",
  survivalRate: "survival_rate",
  xpPerPmcRaid: "xp_per_pmc_raid",
  allPmcKillsPerRaid: "all_kills_per_pmc_raid",
  pmcRaidsPerDay: "pmc_raids_per_day",
};

const PER_RAID_METRICS = new Set<AnomalyMetric>([
  "killedPmcPerRaid",
  "survivalRate",
  "xpPerPmcRaid",
  "allPmcKillsPerRaid",
]);

function metricsFor(row: ProgressionDetailIntervalRow): IntervalMetrics | null {
  if (
    !(Number.isFinite(row.elapsedDays) && row.elapsedDays > 0) ||
    !Object.values(row.changes).every(Number.isFinite)
  ) return null;
  const result = buildSequentialIntervals([
    { profileUpdatedAt: 0, counters: zeroCounters() },
    { profileUpdatedAt: row.elapsedDays * DAY_MS, counters: row.changes },
  ])[0];
  return result?.status === "valid" ? result.metrics : null;
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

function metricValue(metrics: IntervalMetrics, metric: AnomalyMetric): number | null {
  return metrics[metric];
}

function uniqueReasons(anomaly: IntervalAnomalyResult): ProgressionRiskReason[] {
  return [...new Set(anomaly.reasons.map((reason) => REASON_BY_METRIC[reason.metric]))];
}

function buildLongTerm(rows: readonly { row: ProgressionDetailIntervalRow; metrics: IntervalMetrics }[]): SeasonalLongTermPayload {
  if (rows.length === 0) {
    return {
      xpPerDay: null,
      raidsPerDay: null,
      pmcKillsPerDay: null,
      pmcKillsPerRaid: null,
      nonPmcKillsPerDay: null,
      nonPmcKillsPerRaid: null,
      survivalRate: null,
      pvpKd: null,
      aiKd: null,
      overallPmcKd: null,
      intervals: 0,
      coveredRaids: 0,
    };
  }

  const totals = rows.reduce(
    (sum, entry) => {
      sum.days += entry.row.elapsedDays;
      for (const key of Object.keys(sum.changes) as (keyof SeasonalCounters)[]) {
        sum.changes[key] = Number(sum.changes[key] ?? 0) + Number(entry.row.changes[key] ?? 0);
      }
      return sum;
    },
    { days: 0, changes: zeroCounters() },
  );
  const changes = totals.changes;
  const metrics = buildSequentialIntervals([
    { profileUpdatedAt: 0, counters: zeroCounters() },
    { profileUpdatedAt: totals.days * DAY_MS, counters: changes },
  ])[0]?.metrics;
  if (!metrics) throw new TypeError("valid intervals must produce aggregate metrics");

  return {
    xpPerDay: metrics.xpPerDay,
    raidsPerDay: metrics.pmcRaidsPerDay,
    pmcKillsPerDay: metrics.killedPmcPerDay,
    pmcKillsPerRaid: metrics.killedPmcPerRaid,
    nonPmcKillsPerDay: metrics.nonPmcKillsPerDay,
    nonPmcKillsPerRaid: metrics.nonPmcKillsPerRaid,
    survivalRate: metrics.survivalRate == null ? null : metrics.survivalRate * 100,
    pvpKd: metrics.pvpKd,
    aiKd: metrics.aiScavKd,
    overallPmcKd: metrics.overallPmcKd,
    intervals: rows.length,
    coveredRaids: changes.pmcRaids,
  };
}

export function buildSeasonalProgressionDetails(
  input: BuildSeasonalProgressionDetailsInput,
): SeasonalProgressionDetails {
  if (!Number.isFinite(input.trustedStaticScore)) {
    throw new TypeError("trustedStaticScore must be finite");
  }
  const eligible = input.intervals
    .filter((row) => row.mode === (input.mode ?? "seasonal") && row.cycleId === input.cycleId && row.status === "valid")
    .map((row) => ({ row, metrics: metricsFor(row) }))
    .filter((entry): entry is { row: ProgressionDetailIntervalRow; metrics: IntervalMetrics } => entry.metrics !== null);

  const populations = new Map<string, typeof eligible>();
  for (const entry of eligible) {
    populations.set(entry.row.localDate, [...(populations.get(entry.row.localDate) ?? []), entry]);
  }

  const player = eligible
    .filter((entry) => entry.row.aid === input.aid)
    .sort((a, b) => a.row.endedAt - b.row.endedAt);
  const scored: ScoredInterval[] = player.map((entry) => {
    const daily = populations.get(entry.row.localDate) ?? [];
    const percentiles = {} as AnomalyPercentiles;
    for (const metric of Object.keys(REASON_BY_METRIC) as AnomalyMetric[]) {
      const value = metricValue(entry.metrics, metric);
      const targetEligible = value != null && (!PER_RAID_METRICS.has(metric) || entry.row.changes.pmcRaids > 0);
      const population = daily
        .filter((candidate) => !PER_RAID_METRICS.has(metric) || candidate.row.changes.pmcRaids > 0)
        .map((candidate) => metricValue(candidate.metrics, metric))
        .filter((candidate): candidate is number => candidate != null && Number.isFinite(candidate));
      percentiles[metric] = targetEligible ? (percentileRank(value, population) ?? 0) : 0;
    }
    return { ...entry, anomaly: intervalAnomaly(percentiles) };
  });

  const latest = scored.slice(-14);
  const rawProgressionRisk = progressionRisk(latest.map((entry) => entry.anomaly.score));
  const coveredRaids = latest.reduce((sum, entry) => sum + entry.row.changes.pmcRaids, 0);
  const longestInterval = latest.reduce((maximum, entry) => Math.max(maximum, entry.row.elapsedDays), 1);
  const combined = combineCheaterRisk({
    staticScore: input.trustedStaticScore,
    intervalAnomalies: latest.map((entry) => entry.anomaly),
    intervalCount: latest.length,
    newPmcRaids: coveredRaids,
    elapsedDays: longestInterval,
  });
  const reasons = [...new Set(combined.reasons.map((reason) => REASON_BY_METRIC[reason.metric]))];

  return {
    risk: {
      combined: combined.score,
      static: Math.min(100, Math.max(0, input.trustedStaticScore)),
      progression: rawProgressionRisk == null ? null : rawProgressionRisk * 100,
      confidence: { value: combined.confidence.value, tier: combined.confidence.label },
      staticContribution: combined.staticContribution,
      progressionContribution: combined.progressionContribution,
      staticReasons: [...(input.staticReasons ?? [])],
      reasons,
      markers: scored
        .filter((entry) => entry.anomaly.score > 0)
        .map((entry) => ({
          endedAt: entry.row.endedAt,
          date: entry.row.localDate,
          score: entry.anomaly.score * 100,
          reasons: uniqueReasons(entry.anomaly),
        })),
    },
    longTerm: buildLongTerm(player),
  };
}
