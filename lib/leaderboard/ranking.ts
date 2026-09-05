export const LEADERBOARD_FORMULA_VERSION = 1;
export const LEADERBOARD_METRIC_VERSION = 1;

export interface PerformanceFormula {
  kdWeight: number;
  killsPerMatchWeight: number;
  smoothing: number;
  referenceKillsPerMatch: number;
  referenceDeathsPerMatch: number;
}

export interface PerformanceInput {
  matches: number;
  kills: number;
  deaths: number;
}

export type OrderKey = readonly [number, number, number, number, number, number];

const validCount = (value: number) => Number.isSafeInteger(value) && value >= 0;
const validMetric = (value: number) => Number.isFinite(value) && value >= 0;

export function performanceScore(input: PerformanceInput, formula: PerformanceFormula): number | null {
  if (!validCount(input.matches) || !validCount(input.kills) || !validCount(input.deaths)) return null;
  const { kdWeight, killsPerMatchWeight, smoothing: m } = formula;
  const k0 = formula.referenceKillsPerMatch;
  const d0 = formula.referenceDeathsPerMatch;
  if (![kdWeight, killsPerMatchWeight, m, k0, d0].every(validMetric) ||
      Math.abs(kdWeight + killsPerMatchWeight - 1) > Number.EPSILON * 4 ||
      m <= 0 || k0 <= 0 || d0 <= 0) return null;
  const adjustedKills = input.kills + m * k0;
  const adjustedKd = adjustedKills / (input.deaths + m * d0);
  const adjustedKillsPerMatch = adjustedKills / (input.matches + m);
  const kdBase = Math.log1p(k0 / d0);
  const killsBase = Math.log1p(k0);
  const score = 100 * (
    kdWeight * Math.log1p(adjustedKd) / kdBase +
    killsPerMatchWeight * Math.log1p(adjustedKillsPerMatch) / killsBase
  );
  return Number.isFinite(score) && score >= 0 ? score : null;
}

export function kdValue(kills: number | null, deaths: number | null): {
  value: number | null;
  deathless: boolean;
  orderClass: 0 | 1 | 2;
} {
  if (kills == null || deaths == null || !validCount(kills) || !validCount(deaths)) {
    return { value: null, deathless: false, orderClass: 0 };
  }
  if (deaths === 0) return { value: null, deathless: true, orderClass: kills > 0 ? 2 : 0 };
  return { value: kills / deaths, deathless: false, orderClass: 1 };
}

/** All fields sort descending. `-aid` gives a stable ascending account-id tie-break. */
export function orderKey(values: readonly (number | null)[], aid: number): OrderKey {
  if (!Number.isSafeInteger(aid) || aid <= 0 || values.length > 5) throw new Error("invalid leaderboard order key");
  const keys = values.map((value) => value == null ? -1 : value);
  if (!keys.every(Number.isFinite)) throw new Error("leaderboard order keys must be finite");
  while (keys.length < 5) keys.push(-1);
  return [keys[0], keys[1], keys[2], keys[3], keys[4], -aid];
}

export function compareOrderKeys(left: OrderKey, right: OrderKey): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return right[index] - left[index];
  }
  return 0;
}

export function performanceOrderKey(score: number, aid: number): OrderKey {
  return orderKey([score], aid);
}

export function arpOrderKey(input: {
  arp: number;
  blastGangMatches: number | null;
  kills: number | null;
  deaths: number | null;
  killsPerMatch: number | null;
  aid: number;
}): OrderKey {
  const kd = kdValue(input.kills, input.deaths);
  return orderKey([input.arp, input.blastGangMatches, kd.orderClass, kd.value ?? 0, input.killsPerMatch], input.aid);
}

export function metricOrderKey(metric: number, aid: number): OrderKey {
  return orderKey([metric], aid);
}
