// Single-snapshot "cheating risk" model (Layer 1). Produces a 0–100 risk score
// from a player's public aggregate stats, plus a transparent breakdown of which
// signals drove it. This is a statistical SUSPICION score, not proof — see the
// disclaimer rendered in the UI.
//
// Each scored signal is suspicious only when HIGH (high survival, K/D, kills/raid).
// Two evidence sources are combined per signal:
//   - absolute ramp [normal..extreme]: a day-1 floor, also used when the player's
//     playtime bracket has too few samples for a meaningful z-score. Thresholds
//     sit at deliberately blatant levels so legit veterans aren't flagged by it.
//   - within-bracket z-score: (value − mean) / std over players of SIMILAR
//     playtime, so a 3000 h veteran is judged against other veterans, not rookies.
// We take the max of the two, so either a blatant absolute value OR a strong
// in-bracket anomaly raises the score.

import type { ParsedPlayerStats } from "@/types/tarkov";

export interface MetricBaseline {
  mean: number;
  std: number;
}

/** Mean + std of each scored metric over a playtime bracket (from /api/baseline). */
export interface Baseline {
  /** Players the baseline was computed over. */
  n: number;
  metrics: Record<string, MetricBaseline>;
}

export type RiskTier = "low" | "medium" | "high" | "severe";

export interface ScoreFactor {
  /** Metric key — reuses the shared `metric.*` i18n labels. */
  key: string;
  /** This signal's 0..(weight*100) contribution to the final score. */
  points: number;
  /** The player's raw value for this signal. */
  value: number;
  /** Within-bracket z-score, or null when the sample is too thin to trust. */
  z: number | null;
}

export interface CheaterScoreResult {
  /** Final risk score, 0–100. */
  score: number;
  tier: RiskTier;
  /** Per-signal contributions, sorted high→low. */
  factors: ScoreFactor[];
  /** Bracket sample size the baseline came from. */
  sampleN: number;
  /** Whether within-bracket z-scores contributed (vs the absolute-only floor). */
  basedOnSample: boolean;
}

interface SignalDef {
  key: string;
  weight: number;
  /** At/below this the signal is unremarkable (contribution 0). */
  normal: number;
  /** At/above this it's maximally suspicious (contribution 1). */
  extreme: number;
  get: (s: ParsedPlayerStats) => number;
}

const SIGNALS: SignalDef[] = [
  { key: "survival_rate", weight: 0.28, normal: 55, extreme: 88, get: (s) => s.survivalRate },
  { key: "kd_ratio", weight: 0.24, normal: 6, extreme: 16, get: (s) => s.kdRatio },
  { key: "pmc_kd_ratio", weight: 0.24, normal: 4, extreme: 12, get: (s) => s.pmcKdRatio },
  { key: "kills_per_raid", weight: 0.24, normal: 3, extreme: 8, get: (s) => s.killsPerRaid },
];

const MIN_SAMPLE = 30; // bracket players needed before z-scores are trusted
const Z_LO = 2; // z at which a metric starts contributing
const Z_HI = 6; // z at which it's maximally suspicious

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

function tierFor(score: number): RiskTier {
  if (score < 20) return "low";
  if (score < 45) return "medium";
  if (score < 70) return "high";
  return "severe";
}

export function scoreCheater(
  stats: ParsedPlayerStats,
  baseline: Baseline | null
): CheaterScoreResult {
  const sampleN = baseline?.n ?? 0;
  const basedOnSample = sampleN >= MIN_SAMPLE;

  const factors: ScoreFactor[] = SIGNALS.map((sig) => {
    const value = sig.get(stats);
    const abs = clamp01((value - sig.normal) / (sig.extreme - sig.normal));

    let z: number | null = null;
    let rel = 0;
    const b = baseline?.metrics[sig.key];
    if (basedOnSample && b && b.std > 0) {
      z = (value - b.mean) / b.std;
      rel = clamp01((z - Z_LO) / (Z_HI - Z_LO));
    }

    const sub = basedOnSample ? Math.max(abs, rel) : abs;
    return { key: sig.key, points: sig.weight * sub * 100, value, z };
  });

  const score = Math.round(factors.reduce((s, f) => s + f.points, 0));
  factors.sort((a, b) => b.points - a.points);
  return { score, tier: tierFor(score), factors, sampleN, basedOnSample };
}
