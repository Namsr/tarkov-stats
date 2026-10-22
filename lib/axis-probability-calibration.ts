// Temperature scaling fitted to predictions made BEFORE observing their outcomes.
// A single nonnegative scale preserves A/B symmetry and does not reverse sides.
const WINDOW = 1000;
const MIN_SAMPLES = 100;
const REFIT_EVERY = 25;
const PRIOR_STRENGTH = 5;
const COLD_START_STRENGTH = 20;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const sigmoid = (n: number) => 1 / (1 + Math.exp(-clamp(n, -12, 12)));
interface Sample { logit: number; outcome: 0 | 1 }

export function createAxisProbabilityCalibration() {
  const samples: Sample[] = [];
  let observed = 0;
  let scale = 1;

  function fit() {
    // Convex regularized log loss; bisection avoids unstable Newton steps when
    // nearly all scores are zero or the recent outcomes contain only one class.
    let lo = 0, hi = 5;
    for (let iteration = 0; iteration < 24; iteration++) {
      const candidate = (lo + hi) / 2;
      let gradient = PRIOR_STRENGTH * (candidate - 1);
      for (const sample of samples) gradient += sample.logit * (sigmoid(candidate * sample.logit) - sample.outcome);
      if (gradient > 0) hi = candidate;
      else lo = candidate;
    }
    scale = (lo + hi) / 2;
  }

  return {
    probability(logit: number): number {
      if (!Number.isFinite(logit)) throw new TypeError("Invalid Axis calibration score");
      // Before there is enough evidence, shrink confidence toward equal chances.
      const support = observed / (observed + COLD_START_STRENGTH);
      return clamp(sigmoid(clamp(logit, -12, 12) * scale * support), .05, .95);
    },
    observe(logit: number, outcome: 0 | 1) {
      if (!Number.isFinite(logit) || outcome !== 0 && outcome !== 1) throw new TypeError("Invalid Axis calibration observation");
      samples.push({ logit: clamp(logit, -12, 12), outcome });
      if (samples.length > WINDOW) samples.shift();
      observed++;
      // This observation only affects subsequent predictions. Same-time match
      // batches are all predicted before the model calls observe on any of them.
      if (observed >= MIN_SAMPLES && observed % REFIT_EVERY === 0) fit();
    },
  };
}
