// Single-snapshot "cheating risk" model (Layer 1). Produces a 0–100 risk score
// from a player's public aggregate stats, plus a transparent breakdown of which
// signals drove it. This is a statistical SUSPICION score, not proof — see the
// disclaimer rendered in the UI.
//
// Numeric signals are suspicious only when HIGH. Each combines two evidence axes
// (max of the two): an absolute ramp [normal..extreme] (a day-1 floor, also used
// when the playtime bracket is too thin for a z-score) and a within-bracket
// z-score (vs players of SIMILAR playtime, so a veteran is judged against
// veterans). A separate achievement signal flags owning a rare, normally-late
// achievement at low playtime (e.g. "Master of ULTRA" at 100 h).

import type { ParsedPlayerStats } from "@/types/tarkov";

export interface MetricBaseline {
  /** Players in the bracket that actually HAVE this metric (value > 0). The z-score
   * is only trusted once enough of them exist — see scoreCheater. */
  n: number;
  mean: number;
  std: number;
}

/** Mean + std of each scored metric over a playtime bracket (from /api/baseline). */
export interface Baseline {
  n: number;
  metrics: Record<string, MetricBaseline>;
}

/** Per-achievement baseline row used by the rare/early-achievement signal. */
export interface AchievementStat {
  id: string;
  /** Players in the sample who own it. */
  owners: number;
  /** Share of the whole sample that owns it (rarity, %). */
  samplePct: number;
  /** Typical current playtime (hours) of owners — proxy for "normally held by". */
  meanHours: number;
}

export interface AchievementInput {
  /** Achievement ids the scored player owns. */
  ownedIds: string[];
  /** The sample-wide per-achievement baseline. */
  stats: AchievementStat[];
}

export type RiskTier = "low" | "medium" | "high" | "severe";

export interface ScoreFactor {
  /** Factor key — reuses the shared `metric.*` i18n labels. */
  key: string;
  /** This factor's 0..(weight*100) contribution to the final score. */
  points: number;
  /** The player's raw value for this factor (0 for the achievement factor). */
  value: number;
  /** Within-bracket z-score, or null (absolute-only or achievement factor). */
  z: number | null;
}

export interface CheaterScoreResult {
  score: number;
  tier: RiskTier;
  factors: ScoreFactor[];
  sampleN: number;
  basedOnSample: boolean;
}

interface SignalDef {
  key: string;
  weight: number;
  normal: number;
  extreme: number;
  get: (s: ParsedPlayerStats) => number;
}

// Numeric signals (weights sum with ACH_WEIGHT to 1.0). PMC-ONLY by design: Scav
// raids (easy, high-survival, often run-throughs) are excluded so they can neither
// mask nor fake cheating. The combined K/D and the single PMC-vs-PMC K/D collapse
// into one PMC K/D signal here. Keys must match SCORE_COLS in lib/db.ts (the
// within-bracket z-score baseline reads those columns).
const SIGNALS: SignalDef[] = [
  { key: "pmc_survival_rate", weight: 0.2, normal: 55, extreme: 88, get: (s) => s.pmcSurvivalRate },
  { key: "pmc_kd_ratio", weight: 0.24, normal: 4, extreme: 12, get: (s) => s.pmcKdRatio },
  { key: "pmc_kills_per_raid", weight: 0.16, normal: 3, extreme: 8, get: (s) => s.pmcKillsPerRaid },
  { key: "longest_win_streak", weight: 0.1, normal: 15, extreme: 45, get: (s) => s.longestWinStreak },
];

// Achievement signal — weighted highest: owning a rare, normally-late achievement
// at low playtime is hard to fake and a strong tell.
const ACH_WEIGHT = 0.3;
const ACH_MIN_OWNERS = 10; // enough owners for a trustworthy baseline
const ACH_LATE_GAME_HOURS = 200; // only achievements that normally take real time
const ACH_RARE_LO = 3; // samplePct ≤ this → fully "rare"
const ACH_RARE_HI = 30; // samplePct ≥ this → not rare

// Event achievements: obtainable ONLY during past, time-limited events. A long-dormant
// account that earned one years ago looks anomalous next to same-playtime-bracket peers
// who never had the chance to get it — which wrongly inflates its risk. These are still
// COLLECTED and shown (the achievement baseline in lib/db.ts counts every owned id, so
// their prevalence is still visible) — they just must not DRIVE the cheating score.
// Keyed by tarkov.dev achievement id; comments are the in-game names. Exported so the
// EarlyUnlocks panel (the same early-unlock suspicion logic) can exclude them too.
export const EVENT_ACHIEVEMENT_IDS = new Set<string>([
  "660fe21454670811e304c045", // Maslenitsa
  "668bf47c781d446fdc083711", // High Competition
  "6634cae870af846d2868dada", // Local Strong Man
  "6634ca69ee506a5c3e61be56", // Involved in Peace
  "6634c8886e083a141f4aa3f4", // Cardinal Richelieu
  "66742c003a67b164a300fcbf", // A Key to Salvation
  "66e2a7e5919bad697104f4b3", // Highway to the Danger Zone
  "670feb95a4e71050310cc14b", // Complete Remission
  "670febed5ee0fc738a0965a4", // Fatal Outcome
  "675998a894008342eb04e47f", // Khorovod
  "67a0e57117e34930e50075f3", // In Search of an Exit
  "67a0e57b972c11a3f50773b2", // Dungeon Master
  "685d3d6b81d993fda109cdb8", // One Last Ride
  "685d6539127e4806240f3bcd", // Through to the End
  "68936a7a672ffe94a509446b", // Targrad Tales
  "693a83434cb1cf587c0a63f9", // Whiteout
  "6984ab58ee0ae2c0d5075f33", // Duck Hunt
  "69de1be5d378f8aef8008409", // Habet, hoc habet!
  "69de1c2be33584b09a098e93", // Morituri te salutant
  "6a04f93d7a6a2b325906bb5c", // Awaiting Departure
]);

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

// Strongest "rare achievement owned far too early" contribution among owned ones.
// earliness = how far the player's hours sit below the achievement's typical owner
// hours; rarity scales it up for uncommon achievements.
function achievementSub(playerHours: number, ach: AchievementInput | null | undefined): number {
  if (!ach || !(playerHours > 0)) return 0;
  const owned = new Set(ach.ownedIds);
  let best = 0;
  for (const a of ach.stats) {
    if (!owned.has(a.id)) continue;
    if (EVENT_ACHIEVEMENT_IDS.has(a.id)) continue; // event-only — collected, but never scored
    if (a.owners < ACH_MIN_OWNERS || a.meanHours < ACH_LATE_GAME_HOURS) continue;
    const earliness = clamp01((a.meanHours - playerHours) / a.meanHours);
    if (earliness <= 0) continue;
    const rarity = clamp01((ACH_RARE_HI - a.samplePct) / (ACH_RARE_HI - ACH_RARE_LO));
    const contribution = earliness * (0.5 + 0.5 * rarity);
    if (contribution > best) best = contribution;
  }
  return best;
}

export function scoreCheater(
  stats: ParsedPlayerStats,
  baseline: Baseline | null,
  achievements?: AchievementInput | null
): CheaterScoreResult {
  const sampleN = baseline?.n ?? 0;
  const basedOnSample = sampleN >= MIN_SAMPLE;

  const factors: ScoreFactor[] = SIGNALS.map((sig) => {
    const value = sig.get(stats);
    const abs = clamp01((value - sig.normal) / (sig.extreme - sig.normal));

    let z: number | null = null;
    let rel = 0;
    const b = baseline?.metrics[sig.key];
    // Only trust a metric's z-score once enough players actually have it populated.
    // Without this, a column still backfilling (mostly 0s) yields a near-zero mean
    // that makes every real value look like an extreme outlier. Falls back to the
    // absolute ramp, which is ~0 for a below-average player.
    if (basedOnSample && b && b.std > 0 && b.n >= MIN_SAMPLE) {
      z = (value - b.mean) / b.std;
      rel = clamp01((z - Z_LO) / (Z_HI - Z_LO));
    }

    const sub = basedOnSample ? Math.max(abs, rel) : abs;
    return { key: sig.key, points: sig.weight * sub * 100, value, z };
  });

  // Rare/early achievement factor (independent of the bracket sample).
  const aSub = achievementSub(stats.hoursPlayed, achievements);
  factors.push({ key: "ach_early", points: ACH_WEIGHT * aSub * 100, value: aSub, z: null });

  const score = Math.round(factors.reduce((s, f) => s + f.points, 0));
  factors.sort((a, b) => b.points - a.points);
  return { score, tier: tierFor(score), factors, sampleN, basedOnSample };
}
