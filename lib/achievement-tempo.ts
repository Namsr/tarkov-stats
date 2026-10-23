// Calendar intervals describe completed transitions, not active playtime or a
// probability of cheating. This experimental model never contributes risk points.
export const TEMPO_VERSION = 2;
export const TEMPO_MIN_SAMPLE = 100;
export const TEMPO_P1_SAMPLE = 500;
export const TEMPO_TTL_MS = 24 * 60 * 60_000;
const DAY = 86_400_000;
const regularStart = Date.parse("2025-11-15T00:00:00+03:00");
const prestigeStart = Date.parse("2026-05-08T00:00:00+03:00");
export const TEMPO_IDS = [
  "6512f1e3be73cc7f07358ed5", "65140ab8ec10ff011f17cc10", "6514143d59647d2cb3213c93",
  "65141c80ec10ff011f17cc3e", "676091c0f457869a94017a23", "676094451fec2f7426093be6",
  "6842c25bd02bc07d70054019", "6842c27a38482d35ac0bd847", "68d3fe84757f8967ec09099b", "68d3ff840531ed76e808866c",
] as const;
export const TEMPO_TRANSITIONS = [
  { key: "killa15", from: 0, to: 1, since: regularStart },
  { key: "ultra15", from: 1, to: 2, since: regularStart },
  { key: "ultra1", from: 0, to: 2, since: regularStart },
  ...Array.from({ length: 6 }, (_, i) => ({ key: `prestige${i + 1}`, from: i + 3, to: i + 4,
    since: i < 4 ? prestigeStart : regularStart })),
];

// Conservative historical event windows documented by the earlier site study.
// This is deliberately not represented as a complete calendar of boss events.
export const TEMPO_EVENTS = [
  ["2024-08-14T00:00:00+03:00", "2024-08-20T00:00:00+03:00"],
  ["2024-11-29T00:00:00+03:00", "2024-12-06T00:00:00+03:00"],
  ["2025-05-31T00:00:00+03:00", "2025-06-08T00:00:00+03:00"],
].map(([from, to]) => ({ from: Date.parse(from), to: Date.parse(to) }));
export type TempoScope = { mode: "regular" | "seasonal"; cycleId: string; startsAt: number; endsAt: number | null };
export type TempoReason = "missing_dates" | "invalid_dates" | "invalid_profile" | "reversed_dates" | "equal_dates"
  | "outside_period" | "event_overlap" | "seasonal_prestige_unverified" | "insufficient_sample";
export type TempoUnlocks = { times: Record<string, number>; invalid: string[]; malformed: boolean };
export type TempoMeasurement = { key: string; fromAt: number | null; toAt: number | null; days: number | null; reason: TempoReason | null };
export type TempoValue = [days: number, aid: number];
export type TempoCohort = { key: string; values: TempoValue[]; omitted: Partial<Record<TempoReason, number>> };
export type TempoPublication = { version: number; scope: TempoScope; generatedAt: number; exclusions: string;
  profiles: number; cohorts: TempoCohort[] };
export type TempoEvaluation = TempoMeasurement & { n: number; median: number | null; p5: number | null; p1: number | null;
  percentile: number | null; signal: "unavailable" | "typical" | "fast" | "very_fast" };

function timestamp(value: unknown, now: number): number | null {
  if ((typeof value !== "number" && typeof value !== "string") || value === "") return null;
  const n = Number(value);
  const ms = n < 1e12 ? n * 1000 : n;
  return Number.isFinite(ms) && ms >= Date.UTC(2020, 0, 1) && ms <= now ? ms : null;
}

export function parseTempoUnlocks(statsJson: string, achievementsJson: string | null, now: number): TempoUnlocks {
  const times: Record<string, number> = {};
  const invalid = new Set<string>();
  let malformed = false;
  const add = (id: string, raw: unknown) => {
    if (!(TEMPO_IDS as readonly string[]).includes(id) || raw == null) return;
    const at = timestamp(raw, now);
    if (at === null || (times[id] !== undefined && times[id] !== at)) invalid.add(id);
    else times[id] = at;
  };
  try {
    const stats = JSON.parse(statsJson);
    if (!stats || typeof stats !== "object" || Array.isArray(stats)) malformed = true;
    else if (stats.achievementUnlocks != null) {
      if (typeof stats.achievementUnlocks !== "object" || Array.isArray(stats.achievementUnlocks)) malformed = true;
      else for (const [id, at] of Object.entries(stats.achievementUnlocks)) add(id, at);
    }
    const achievements = achievementsJson == null ? [] : JSON.parse(achievementsJson);
    if (Array.isArray(achievements)) {
      for (const item of achievements) if (item && typeof item === "object" && typeof item.id === "string") add(item.id, item.unlockedAt);
    } else if (achievements && typeof achievements === "object") {
      for (const [id, at] of Object.entries(achievements)) add(id, at);
    } else malformed = true;
  } catch { malformed = true; }
  for (const id of invalid) delete times[id];
  return { times, invalid: [...invalid], malformed };
}

export function measureTempo(unlocks: TempoUnlocks, scope: TempoScope,
  events = TEMPO_EVENTS): TempoMeasurement[] {
  // A broken known chain is missing evidence, never extreme speed.
  const brokenPrestige = TEMPO_IDS.slice(4).some((id, i, ids) =>
    ids.slice(i + 1).some((next) => unlocks.times[id] !== undefined && unlocks.times[next] !== undefined
      && unlocks.times[id] >= unlocks.times[next]));
  const brokenKilla = TEMPO_IDS.slice(0, 3).some((id, i, ids) =>
    ids.slice(i + 1).some((next) => unlocks.times[id] !== undefined && unlocks.times[next] !== undefined
      && unlocks.times[id] >= unlocks.times[next]));
  return TEMPO_TRANSITIONS.map((transition) => {
    const fromId = TEMPO_IDS[transition.from], toId = TEMPO_IDS[transition.to];
    const fromAt = unlocks.times[fromId] ?? null, toAt = unlocks.times[toId] ?? null;
    let reason: TempoReason | null = null;
    if (unlocks.malformed) reason = "invalid_profile";
    else if (scope.mode === "seasonal" && transition.from >= 3) reason = "seasonal_prestige_unverified";
    else if (unlocks.invalid.includes(fromId) || unlocks.invalid.includes(toId)) reason = "invalid_dates";
    else if (fromAt === null || toAt === null) reason = "missing_dates";
    else if (fromAt > toAt) reason = "reversed_dates";
    else if (fromAt === toAt) reason = "equal_dates";
    else if (transition.from >= 3 ? brokenPrestige : brokenKilla) reason = "invalid_dates";
    else if (fromAt < (scope.mode === "regular" ? transition.since : scope.startsAt)
      || (scope.endsAt !== null && toAt >= scope.endsAt)) reason = "outside_period";
    else if (transition.from < 3 && events.some((event) => fromAt < event.to && toAt >= event.from)) reason = "event_overlap";
    return { key: transition.key, fromAt, toAt, days: reason || fromAt === null || toAt === null ? null : (toAt - fromAt) / DAY, reason };
  });
}

/** Nearest-rank quantile over an already sorted publication, leaving out one aid. */
export function evaluateTempo(measurement: TempoMeasurement, cohort: TempoCohort, aid: number): TempoEvaluation {
  const self = cohort.values.findIndex((value) => value[1] === aid);
  const n = cohort.values.length - (self < 0 ? 0 : 1);
  const quantile = (p: number): number | null => {
    if (!n) return null;
    const index = Math.max(0, Math.ceil(n * p) - 1);
    return cohort.values[index + (self >= 0 && index >= self ? 1 : 0)][0];
  };
  const median = quantile(0.5), p5 = quantile(0.05), p1 = n >= TEMPO_P1_SAMPLE ? quantile(0.01) : null;
  let percentile: number | null = null;
  if (!measurement.reason && measurement.days !== null && n >= TEMPO_MIN_SAMPLE) {
    let lo = 0, hi = cohort.values.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cohort.values[mid][0] <= measurement.days) lo = mid + 1;
      else hi = mid;
    }
    percentile = (lo - (self >= 0 && cohort.values[self][0] <= measurement.days ? 1 : 0)) / n * 100;
  }
  const reason = measurement.reason ?? (n < TEMPO_MIN_SAMPLE ? "insufficient_sample" : null);
  const signal = reason ? "unavailable" : p1 !== null && measurement.days! < p1 ? "very_fast"
    : p5 !== null && measurement.days! < p5 ? "fast" : "typical";
  return { ...measurement, reason, n, median, p5, p1, percentile, signal };
}

export function summarizeTempo(cohort: TempoCohort) {
  const value = (p: number) => cohort.values[Math.max(0, Math.ceil(cohort.values.length * p) - 1)]?.[0] ?? null;
  return { key: cohort.key, n: cohort.values.length, median: value(0.5), p5: value(0.05),
    p1: cohort.values.length >= TEMPO_P1_SAMPLE ? value(0.01) : null, omitted: cohort.omitted,
    examples: cohort.values.length >= TEMPO_MIN_SAMPLE ? cohort.values.slice(0, 5).map(([, aid]) => aid) : [] };
}
