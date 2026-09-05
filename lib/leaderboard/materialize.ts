import type { ArenaModeKey } from "@/types/arena";
import type { LeaderboardStats, LeaderboardSubjectStatus, LeaderboardSort } from "@/types/leaderboard";
import type { LeaderboardScopeConfig } from "./config";
import {
  LEADERBOARD_FORMULA_VERSION,
  LEADERBOARD_METRIC_VERSION,
  arpOrderKey,
  kdValue,
  metricOrderKey,
  orderKey,
  performanceOrderKey,
  performanceScore,
  type PerformanceFormula,
}
// @ts-expect-error Node's direct TypeScript runner needs the explicit extension.
from "./ranking.ts";
import type { PublishedMember, PublishedOrder } from "./publication.ts";

export interface LeaderboardSourceRow {
  aid: number;
  nickname: string;
  sourceUpdatedAt: number;
  sourceRevision?: number;
  parserVersion: number;
  activityAt: number | null;
  activitySource: "skill" | "gameplay_date" | "counter_delta" | "profile_check" | null;
  matches: number | null;
  kills: number | null;
  deaths: number | null;
  hours: number | null;
  currentArp: number | null;
  bestArp: number | null;
}

export interface MaterializeContext {
  config: LeaderboardScopeConfig;
  formula: PerformanceFormula | null;
}

export interface MaterializedCandidate {
  member: PublishedMember;
  orders: PublishedOrder[];
}

const count = (value: number | null): value is number => Number.isSafeInteger(value) && value! >= 0;
const metric = (value: number | null): value is number => value != null && Number.isFinite(value) && value >= 0;

export function sourceFingerprint(row: LeaderboardSourceRow): string {
  return [row.nickname, row.sourceUpdatedAt, row.parserVersion, row.activityAt ?? "", row.activitySource ?? "",
    row.matches ?? "", row.kills ?? "", row.deaths ?? "", row.hours ?? "",
    row.currentArp ?? "", row.bestArp ?? ""].join("|");
}

function statsFor(row: LeaderboardSourceRow): LeaderboardStats {
  const kd = kdValue(row.kills, row.deaths);
  return {
    raidsOrMatches: row.matches,
    kills: row.kills,
    deaths: row.deaths,
    kd: kd.value,
    deathless: kd.deathless,
    killsPerMatch: count(row.kills) && count(row.matches) && row.matches > 0 ? row.kills / row.matches : null,
    hours: row.hours,
    arp: row.currentArp ?? row.bestArp,
    currentArp: row.currentArp,
    bestArp: row.bestArp,
    arpSource: row.currentArp != null ? "current" : row.bestArp != null ? "best" : null,
  };
}

function statusFor(row: LeaderboardSourceRow, context: MaterializeContext, stats: LeaderboardStats): LeaderboardSubjectStatus {
  if (row.activityAt == null || row.activityAt < context.config.activityCutoffMs) return "inactive";
  if (context.config.primaryMetric === "arp") {
    if (!context.config.arpSourceConfirmed) return "season_unverified";
    return stats.arp == null ? "missing_metrics" : "ranked";
  }
  if (!count(row.matches) || !count(row.kills) ||
      (context.config.primaryMetric === "performance" && !count(row.deaths))) return "missing_metrics";
  if (row.matches < context.config.minimumSample) return "insufficient_sample";
  if (context.config.primaryMetric === "performance" && !context.formula) return "reference_unavailable";
  return "ranked";
}

export function materializeCandidate(row: LeaderboardSourceRow, context: MaterializeContext): MaterializedCandidate {
  if (!Number.isSafeInteger(row.aid) || row.aid <= 0) throw new Error("invalid leaderboard source aid");
  const stats = statsFor(row);
  const status = statusFor(row, context, stats);
  const score = status !== "ranked" ? null
    : context.config.primaryMetric === "arp" ? stats.arp
    : context.config.primaryMetric === "killsPerMatch" ? stats.killsPerMatch
    : performanceScore({ matches: row.matches!, kills: row.kills!, deaths: row.deaths! }, context.formula!);
  const finalStatus = status === "ranked" && score == null ? "missing_metrics" : status;
  const member: PublishedMember = {
    aid: row.aid, nickname: row.nickname || "Unknown", sourceUpdatedAt: row.sourceUpdatedAt,
    sourceRevision: Number(row.sourceRevision) || 0,
    parserVersion: row.parserVersion, metricVersion: LEADERBOARD_METRIC_VERSION,
    sourceFingerprint: sourceFingerprint(row), status: finalStatus, score, stats,
  };
  const orders: PublishedOrder[] = [];
  const active = row.activityAt != null && row.activityAt >= context.config.activityCutoffMs;
  if (active && metric(stats.hours)) {
    orders.push({ sort: "hours", aid: row.aid, key: metricOrderKey(stats.hours, row.aid) });
  }
  const sampleReady = count(row.matches) && row.matches >= context.config.minimumSample;
  if (active && sampleReady && stats.killsPerMatch != null) {
    orders.push({ sort: "killsPerMatch", aid: row.aid, key: metricOrderKey(stats.killsPerMatch, row.aid) });
  }
  const kd = kdValue(row.kills, row.deaths);
  if (active && sampleReady && kd.orderClass > 0) {
    orders.push({ sort: "kd", aid: row.aid, key: orderKey([kd.orderClass, kd.value ?? 0], row.aid) });
  }
  if (finalStatus === "ranked" && score != null) {
    const key = context.config.primaryMetric === "arp"
      ? arpOrderKey({ arp: score, blastGangMatches: row.matches, kills: row.kills, deaths: row.deaths,
        killsPerMatch: stats.killsPerMatch, aid: row.aid })
      : performanceOrderKey(score, row.aid);
    orders.push({ sort: "primary", aid: row.aid, key });
  }
  return { member, orders };
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  values.sort((left, right) => left - right);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

export function referenceFormula(rows: Iterable<LeaderboardSourceRow>, activityCutoffMs: number): PerformanceFormula | null {
  const killsPerMatch: number[] = [];
  const deathsPerMatch: number[] = [];
  for (const row of rows) {
    if (row.activityAt == null || row.activityAt < activityCutoffMs ||
        !count(row.matches) || row.matches < 20 || !count(row.kills) || !count(row.deaths)) continue;
    killsPerMatch.push(row.kills / row.matches);
    deathsPerMatch.push(row.deaths / row.matches);
  }
  const k0 = median(killsPerMatch);
  const d0 = median(deathsPerMatch);
  if (k0 == null || d0 == null || k0 <= 0 || d0 <= 0) return null;
  return { kdWeight: 0.7, killsPerMatchWeight: 0.3, smoothing: 20,
    referenceKillsPerMatch: k0, referenceDeathsPerMatch: d0 };
}

export function primaryMetricForArena(mode: ArenaModeKey): "arp" | "killsPerMatch" | "performance" {
  return mode === "blastGang" ? "arp" : mode === "lastHero" ? "killsPerMatch" : "performance";
}

export function allowedSorts(): readonly LeaderboardSort[] {
  return ["primary", "kd", "killsPerMatch", "hours"];
}

export { LEADERBOARD_FORMULA_VERSION, LEADERBOARD_METRIC_VERSION };
