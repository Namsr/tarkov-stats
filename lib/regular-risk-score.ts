import type { ParsedPlayerStats, RegularRiskInputs } from "../types/tarkov.ts";
import { EVENT_ACHIEVEMENT_IDS, type AchievementInput, type Baseline, type CheaterScoreResult, type MetricBaseline, type ScoreFactor } from "./cheater-score.ts";

export const REGULAR_RISK_MIN_SAMPLE = 30;
export const REGULAR_RISK_MAX_COHORT = 2000;
const PRIOR_RAIDS = 20;
const WINDOWS = [10, 15, 20, 30] as const;
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
export function regularHoursMultiplier(hours: number): number {
  return 1 + 2 * Math.max(0, 1 - Math.max(0, hours) / 1000);
}

/** Incompatible tuples are missing evidence, never evidence of cheating. */
export function validatedRegularRiskInputs(raw?: RegularRiskInputs): RegularRiskInputs {
  const result = Object.fromEntries(["raids", "deaths", "survived", "kills", "killedPmc", "streak", "prestige"].map((key) => [key, count(raw?.[key as keyof RegularRiskInputs]) ? raw![key as keyof RegularRiskInputs] : null])) as unknown as RegularRiskInputs;
  const raids = result.raids;
  if (raids === null) {
    result.deaths = result.survived = result.kills = result.killedPmc = result.streak = null;
    return result;
  }
  if (result.deaths !== null && result.deaths > raids) result.deaths = null;
  if (result.survived !== null && result.survived > raids) result.survived = null;
  if (result.streak !== null && result.streak > raids) result.streak = null;
  if (result.deaths !== null && result.survived !== null && result.deaths + result.survived > raids) result.deaths = result.survived = null;
  // The counter is a signed 32-bit upstream count. Near-overflow tuples cannot
  // describe a raid and must not become a maximum-risk combat signal.
  if (result.kills !== null && (raids === 0 && result.kills > 0 || result.kills >= 2_000_000_000)) result.kills = null;
  if (result.killedPmc !== null && (raids === 0 && result.killedPmc > 0 || result.killedPmc >= 2_000_000_000 || result.kills !== null && result.killedPmc > result.kills)) result.killedPmc = null;
  return result;
}

type Prior = NonNullable<MetricBaseline["prior"]>;
const EMPTY_PRIOR: Prior = { survival: 0, deaths: 0, kills: 0, killedPmc: 0 };
function values(raw: RegularRiskInputs, prior: Prior): Record<string, number | null> {
  const raids = raw.raids;
  const p = PRIOR_RAIDS;
  const rate = (n: number | null, anchor: number) => raids !== null && raids > 0 && n !== null ? (n + p * anchor) / (raids + p) : null;
  const kd = (kills: number | null, anchor: number) => raids !== null && raids > 0 && kills !== null && raw.deaths !== null
    ? (kills + p * anchor) / Math.max(1, raw.deaths + p * prior.deaths) : null;
  return {
    pmc_survival_rate: rate(raw.survived, prior.survival) === null ? null : rate(raw.survived, prior.survival)! * 100,
    longest_win_streak: raw.streak,
    pmc_kd_ratio: kd(raw.killedPmc, prior.killedPmc),
    killed_pmc_per_raid: rate(raw.killedPmc, prior.killedPmc),
    pmc_all_kd_ratio: kd(raw.kills, prior.kills),
    pmc_kills_per_raid: rate(raw.kills, prior.kills),
    prestige: raw.prestige,
  };
}
function trimmedMean(sorted: number[]): number {
  const trim = Math.floor(sorted.length * 0.1);
  const kept = sorted.slice(trim, sorted.length - trim);
  return kept.reduce((sum, v) => sum + v, 0) / kept.length;
}
function representative(rows: RegularRiskInputs[]): Prior {
  const meanRate = (key: "survived" | "deaths" | "kills" | "killedPmc") => {
    const rates = rows.flatMap((r) => r.raids! > 0 && r[key] !== null ? [r[key]! / r.raids!] : []).sort((a, b) => a - b);
    return rates.length >= REGULAR_RISK_MIN_SAMPLE ? trimmedMean(rates) : 0;
  };
  return { survival: meanRate("survived"), deaths: meanRate("deaths"), kills: meanRate("kills"), killedPmc: meanRate("killedPmc") };
}
export interface RegularRiskPeer {
  aid: number;
  hours: number;
  raw: RegularRiskInputs;
}
/** Each metric selects its own smallest populated two-dimensional window. */
export function buildRegularRiskBaseline(peers: readonly RegularRiskPeer[], center: { hours: number; pmcRaids: number }, excludeAid: number): Baseline {
  const metrics: Baseline["metrics"] = {};
  let largestN = 0;
  let largestPercent = 10;
  for (const percent of WINDOWS) {
    const span = percent / 100;
    const rows = peers.filter((peer) => peer.aid !== excludeAid && Number.isFinite(peer.hours) && peer.hours > 0 && Math.abs(peer.hours - center.hours) <= center.hours * span && peer.raw.raids !== null && Math.abs(peer.raw.raids - center.pmcRaids) <= center.pmcRaids * span).map((peer) => validatedRegularRiskInputs(peer.raw));
    largestN = Math.max(largestN, rows.length);
    const prior = representative(rows);
    const populated = rows.map((raw) => values(raw, prior));
    for (const key of Object.keys(values(validatedRegularRiskInputs(), EMPTY_PRIOR))) {
      if (metrics[key]?.n >= REGULAR_RISK_MIN_SAMPLE) continue;
      const sorted = populated.flatMap((row) => row[key] === null ? [] : [row[key]!]).sort((a, b) => a - b);
      const n = sorted.length;
      const mean = n ? trimmedMean(sorted) : 0;
      metrics[key] = { n, mean, std: n ? Math.sqrt(sorted.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n) : 0,
        p90: n ? sorted[Math.ceil(n * 0.9) - 1] : 0, p99: n ? sorted[Math.ceil(n * 0.99) - 1] : 0, percent, prior };
      if (n >= REGULAR_RISK_MIN_SAMPLE) largestPercent = Math.max(largestPercent, percent);
    }
  }
  return { n: largestN, metrics, strategy: "matched", percent: largestPercent };
}

const DEFS = [
  ["pmc_survival_rate", "survival", 30], ["longest_win_streak", "survival", 30],
  ["pmc_kd_ratio", "combat", 35], ["killed_pmc_per_raid", "combat", 35],
  ["pmc_all_kd_ratio", "combat", 20], ["pmc_kills_per_raid", "combat", 20],
  ["prestige", "progression", 35],
] as const;
const ULTRA = "6514143d59647d2cb3213c93";
const KAPPA = new Set(["664f1f8768508d74604bf556", "6a60f75f1a1222ee000baf0d"]);

export function scoreRegularCheater(stats: ParsedPlayerStats, baseline: Baseline | null, achievements?: AchievementInput | null): CheaterScoreResult {
  const validHours = Number.isFinite(stats.hoursPlayed) && stats.hoursPlayed > 0;
  const multiplier = regularHoursMultiplier(validHours ? stats.hoursPlayed : 1000);
  const raw = validatedRegularRiskInputs(stats.regularRiskInputs);
  const factors: ScoreFactor[] = DEFS.map(([key, group, weight]) => {
    const b = baseline?.strategy === "matched" ? baseline.metrics[key] : null;
    const value = values(raw, b?.prior ?? EMPTY_PRIOR)[key];
    const available = validHours && value !== null && Number.isFinite(value) && !!b && Number.isSafeInteger(b.n) && b.n >= REGULAR_RISK_MIN_SAMPLE && Number.isFinite(b.mean) && b.mean >= 0 && Number.isFinite(b.p90) && b.p90! >= 0 && Number.isFinite(b.p99) && b.p99! >= b.p90!;
    let strength = 0;
    if (available && value! > b!.p90!) {
      // A flat sample gives no tail shape. Use a proportional extension above
      // its observed top; never turn one tiny positive count into full risk.
      const spread = Math.max(b!.p99! - b!.p90!, Math.abs(b!.mean) * 0.5, 1);
      strength = clamp((value! - b!.p90!) / spread);
    }
    return { key, group, value: value ?? 0, z: null, available,
      reason: !validHours || value === null ? "missing_metric" : !available ? "insufficient_cohort" : undefined,
      cohortMean: b?.mean ?? null, cohortN: b?.n ?? 0, p90: b?.p90 ?? null, p99: b?.p99 ?? null,
      cohortPercent: b?.percent,
      ratio: available && b!.mean > 0 ? value! / b!.mean : null,
      hoursMultiplier: multiplier, evidencePoints: available ? weight * strength * multiplier : 0, points: 0 };
  });
  const owned = new Set(achievements?.ownedIds ?? []);
  const familyBest = new Map<string, ScoreFactor>();
  for (const a of achievements?.stats ?? []) {
    if (!owned.has(a.id) || EVENT_ACHIEVEMENT_IDS.has(a.id)) continue;
    const family = KAPPA.has(a.id) ? "kappa" : a.id;
    const critical = a.id === ULTRA || KAPPA.has(a.id);
    const reliable = validHours && Number.isSafeInteger(a.hoursOwners) && a.hoursOwners! >= REGULAR_RISK_MIN_SAMPLE && Number.isFinite(a.earlyHours) && a.earlyHours > 0 && Number.isFinite(a.meanHours) && a.meanHours >= a.earlyHours &&
      (critical || Number.isFinite(a.samplePct) && a.samplePct >= 0 && a.samplePct <= 100);
    const early = reliable ? clamp(1 - stats.hoursPlayed / a.earlyHours) : 0;
    const rarity = Number.isFinite(a.samplePct) ? clamp(1 - a.samplePct / 100) : 0;
    const evidencePoints = reliable ? Math.min(critical ? 85 : 35, 35 * multiplier * early * (critical ? 1 : rarity)) : 0;
    const factor: ScoreFactor = { key: "ach_early", achievementId: a.id, group: "progression", value: stats.hoursPlayed, z: null, available: reliable,
      reason: reliable ? undefined : "insufficient_owners", cohortMean: a.meanHours, cohortN: a.hoursOwners ?? 0, p90: null, p99: null,
      ownerHoursP20: reliable ? a.earlyHours : null,
      ratio: reliable ? stats.hoursPlayed / a.earlyHours : null, hoursMultiplier: multiplier, evidencePoints, points: 0 };
    if (!familyBest.has(family) || evidencePoints > familyBest.get(family)!.evidencePoints!) familyBest.set(family, factor);
  }
  factors.push(...familyBest.values());
  // Maximum within each correlated group. Survival and KD share deaths, so
  // use only their strongest group for corroboration against progression.
  const winners = ["survival", "combat", "progression"].flatMap((group) => {
    const candidate = factors.filter((f) => f.group === group && f.available).sort((a, b) => b.evidencePoints! - a.evidencePoints!)[0];
    return candidate ? [candidate] : [];
  }).sort((a, b) => b.evidencePoints! - a.evidencePoints!);
  const combatWinner = winners.find((f) => f.group === "survival" || f.group === "combat");
  const progressionWinner = winners.find((f) => f.group === "progression");
  const independentWinners = [combatWinner, progressionWinner].filter((f): f is ScoreFactor => !!f).sort((a, b) => b.evidencePoints! - a.evidencePoints!);
  const primary = independentWinners[0];
  if (primary) primary.points = Math.min(100, primary.evidencePoints!);
  const corroboration = primary ? Math.min(15, independentWinners.slice(1).reduce((sum, f) => sum + f.evidencePoints! * 0.2, 0), 100 - primary.points) : 0;
  factors.push({ key: "compound_anomaly", group: "corroboration", value: corroboration, z: null, available: !!primary, evidencePoints: corroboration, points: corroboration, hoursMultiplier: multiplier });
  const availableCount = factors.filter((f) => f.available && f.group !== "corroboration").length;
  const score = Math.min(100, Math.round(factors.reduce((sum, f) => sum + f.points, 0)));
  // Put rounding in the largest contribution so the displayed breakdown sums.
  if (primary) primary.points += score - factors.reduce((sum, f) => sum + f.points, 0);
  const availability = availableCount === 0 ? "unavailable" : factors.some((f) => !f.available && f.group !== "corroboration") ? "partial" : "available";
  const sampleN = Math.max(0, ...factors.filter((f) => f.available).map((f) => f.cohortN ?? 0));
  return { score, tier: score < 20 ? "low" : score < 45 ? "medium" : score < 70 ? "high" : "severe", factors: factors.sort((a, b) => b.points - a.points), sampleN, basedOnSample: availableCount > 0, availability, confidence: availableCount ? availableCount / Math.max(1, factors.length - 1) : 0, hoursMultiplier: multiplier };
}
