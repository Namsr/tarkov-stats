// @ts-expect-error Node's strip-types runner needs explicit extensions.
import { normalizeProfileSkill, type ProfileSkill } from "./profile-skills.ts";
import type { ComparisonScope } from "../types/comparison";
import type { PublicRiskView } from "../types/profile-view";
import type { ProgressionMetricKey, ProgressionTimelineResponse } from "../types/seasonal";
import type { ArenaModeTsRating } from "./arena/ts-rating";

export interface ComparisonAchievement {
  id: string; name: string; nameRu: string | null; description: string | null;
  descriptionRu: string | null; imageUrl: string | null; unlockedAt: number | null;
  rarity: string | null; percentage: number | null; officialPercentage: number | null;
}
export interface ComparisonMastery { id: string; weapon: string; progress: number; level: number }
export interface ComparisonDossier {
  aid: number; nickname: string; side: string | null; lastAccessAt: number | null;
  values: Record<string, number | null>; risk: PublicRiskView | null;
  achievements: ComparisonAchievement[]; skills: ProfileSkill[]; mastery: ComparisonMastery[];
  arenaRating: Pick<ArenaModeTsRating, "rating" | "displayReady" | "reason" | "provisional"> | null;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
export function comparisonNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function rows(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function first(...values: unknown[]): number | null {
  for (const value of values) { const number = comparisonNumber(value); if (number !== null) return number; }
  return null;
}
function riskView(value: unknown): PublicRiskView | null {
  const risk = record(value), overall = record(risk.overall);
  const score = comparisonNumber(risk.score);
  if (score === null) return null;
  return {
    score, tier: text(risk.tier), confidence: comparisonNumber(risk.confidence),
    sampleN: first(risk.sampleN, risk.sampleSize, overall.peerCount),
    freshnessAt: first(risk.freshnessAt, record(risk.freshness).evaluatedAt),
    factors: rows(risk.factors).flatMap(value => {
      if (typeof value === "string") return [{ key: value, points: null, available: true }];
      const item = record(value), key = text(item.key);
      return key ? [{ key, points: comparisonNumber(item.points), available: item.available !== false }] : [];
    }),
  };
}
export function comparisonAdvantage(left: number | null, right: number | null): { winner: 0 | 1; ratio: number | null; difference: number } | null {
  if (left === null || right === null || !Number.isFinite(left) || !Number.isFinite(right) || left < 0 || right < 0 || left === right) return null;
  const lower = Math.min(left, right), higher = Math.max(left, right);
  return { winner: left > right ? 0 : 1, ratio: lower > 0 ? higher / lower : null, difference: higher - lower };
}
export function comparisonTimelineBenchmark(timeline: ProgressionTimelineResponse, metric: ProgressionMetricKey): { value: number; n: number; population: boolean } | null {
  const series = timeline.metrics[metric];
  if (!series) return null;
  const anchor = [...series.player].sort((left, right) => (right.observedAt ?? 0) - (left.observedAt ?? 0))[0];
  if (!anchor) return null;
  for (const [points, population] of [[series.nearby, false], [series.overall, true]] as const) {
    const candidates = points.filter(point => comparisonNumber(point.value) !== null && (point.sampleN ?? point.n) > 0);
    const selected = [...candidates].sort((left, right) => Math.abs(left.pmcRaids - anchor.pmcRaids) - Math.abs(right.pmcRaids - anchor.pmcRaids)
      || Math.abs((left.observedAt ?? 0) - (anchor.observedAt ?? 0)) - Math.abs((right.observedAt ?? 0) - (anchor.observedAt ?? 0)))[0];
    if (selected) return { value: selected.value!, n: selected.sampleN ?? selected.n, population };
  }
  return null;
}
export function comparisonDossier(scope: ComparisonScope, aid: number, payload: unknown): ComparisonDossier | null {
  const body = record(payload), identity = record(body.identity);
  if (identity.aid !== aid || identity.mode !== scope.mode || identity.cycleId !== scope.cycleId) return null;
  if (scope.mode === "arena" && identity.arenaMode !== undefined && identity.arenaMode !== scope.arenaMode) return null;
  const profile = record(body.profile), stats = record(body.stats), seasonal = record(profile.seasonalStats);
  const view = record(body.viewModel), viewIdentity = record(view.identity);
  if (body.viewModel != null && (viewIdentity.aid !== aid || viewIdentity.mode !== scope.mode || viewIdentity.cycleId !== scope.cycleId)) return null;
  const statistics = record(view.statistics), overview = record(view.overview), progression = record(view.progression);
  const counters = record(profile.counters), arena = record(body.arena), arenaOverall = record(arena.overall);
  const source = scope.mode === "seasonal" ? seasonal : stats;
  const comparison = record(body.comparisonStats);
  const values: Record<string, number | null> = {};
  let arenaRating: ComparisonDossier["arenaRating"] = null;
  const fields = ["totalRaids", "pmcRaids", "scavRaids", "survivalRate", "pmcSurvivalRate", "kdRatio", "pmcKdRatio", "totalKills", "deaths", "pmcDeaths", "runThrough", "longestWinStreak", "level", "prestige", "experience", "achievementsCount", "survivedRaids", "pmcSurvived", "pmcExitKilled", "pmcExitLeft", "pmcExitTransit", "pmcExitMia", "killsPerRaid"];
  for (const key of fields) values[key] = first(source[key], statistics[key], counters[key], progression[key], overview[key], comparison[key]);
  values.hours = first(stats.hoursPlayed, profile.lifetimePvpHours, overview.lifetimePvpHours, arenaOverall.hours);
  values.killedPmc = stats.pvpStatsKnown === false ? null : first(stats.pmcKilledPmc, stats.killedPmc, counters.killedPmc, statistics.pmcKills);
  values.pmcAllKills = first(stats.pmcKills, counters.pmcKills);
  values.pmcKdRatio = stats.pvpStatsKnown === false ? null : values.pmcKdRatio;
  // The missing exact PMC-kill counter does not make survival unknown.
  values.pmcSurvivalRate = first(source.pmcSurvivalRate, overview.pmcSurvivalRate, statistics.pmcSurvivalRate,
    values.pmcRaids && values.pmcSurvived !== null ? 100 * values.pmcSurvived / values.pmcRaids : null);
  values.killedPmcPerRaid = values.pmcRaids && values.killedPmc !== null ? values.killedPmc / values.pmcRaids : null;
  if (scope.mode === "arena") {
    values.hours = comparisonNumber(arenaOverall.hours);
    const arenas = { overall: arenaOverall, ...record(arena.modes) };
    for (const [mode, data] of Object.entries(arenas)) {
      const row = record(data);
      for (const group of [record(row.counters), record(row.metrics)]) {
        for (const [key, value] of Object.entries(group)) values[`arena_${mode}_${key}`] = comparisonNumber(value);
      }
    }
    values.bestArp = comparisonNumber(arenaOverall.bestArp);
    const rating = record(body.tsRating);
    const selectedRating = scope.arenaMode === "overall" ? rating.overall : record(rating.modes)[scope.arenaMode];
    const ratingItem = record(selectedRating), risk = record(body.risk);
    const riskItem = scope.arenaMode === "overall" ? risk.overall : rows(risk.modes).find(item => record(item).mode === scope.arenaMode);
    values.tsRating = ratingItem.displayReady === true ? comparisonNumber(ratingItem.rating) : null;
    values.arenaRisk = comparisonNumber(record(riskItem).score);
    if (selectedRating != null) {
      const reason = text(ratingItem.reason);
      arenaRating = { rating: values.tsRating, displayReady: ratingItem.displayReady === true && values.tsRating !== null,
        provisional: ratingItem.provisional === true,
        reason: reason && ["missing_counters", "inconsistent_results", "no_matches", "insufficient_reference", "incomplete_coverage"].includes(reason)
          ? reason as ArenaModeTsRating["reason"] : null };
    }
  }
  const achievements = rows(record(view.achievements).items).flatMap(value => {
    const item = record(value), id = text(item.id);
    if (!id) return [];
    const image = text(item.imageUrl);
    return [{ id, name: text(item.name) ?? id, nameRu: text(item.nameRu), description: text(item.description),
      descriptionRu: text(item.descriptionRu),
      imageUrl: image && /^https:\/\/assets\.tarkov\.dev\/achievement-[a-f0-9]{24}-icon\.webp$/i.test(image) ? image : null,
      unlockedAt: comparisonNumber(item.unlockedAt), rarity: text(item.rarity),
      percentage: comparisonNumber(item.percentage), officialPercentage: comparisonNumber(item.officialPercentage) }];
  });
  const skills = rows(record(view.skills).items).flatMap(value => { const skill = normalizeProfileSkill(value); return skill ? [skill] : []; });
  const mastery = rows(record(view.mastering).items).flatMap(value => {
    const item = record(value), id = text(item.id), weapon = text(item.weapon), progress = comparisonNumber(item.progress), level = comparisonNumber(item.level);
    return id && weapon && progress !== null && level !== null && [1, 2, 3].includes(level) ? [{ id, weapon, progress, level }] : [];
  });
  return { aid, nickname: text(stats.nickname) ?? text(profile.nickname) ?? text(arena.nickname) ?? text(viewIdentity.nickname) ?? `#${aid}`,
    side: text(stats.side) ?? text(profile.side) ?? text(record(profile.info).side), lastAccessAt: first(profile.lastAccessAt, stats.lastPlayedAt, record(view.freshness).lastAccessAt),
    values, risk: riskView(view.risk ?? body.risk ?? body.arenaRisk), achievements, skills, mastery, arenaRating };
}
