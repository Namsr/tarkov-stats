export const ACHIEVEMENT_UNLOCK_P1_MIN_SAMPLE = 500;

// Percentile sources leave the column NULL when a rank does not resolve, and 0
// when a real owner has zero playtime. `||` cannot tell those apart and would
// replace a genuine 0 with the mean, so take the first value that is actually a
// finite number instead of the first truthy one.
export function firstFiniteHours(...values: unknown[]): number {
  for (const value of values) {
    if (value == null) continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

/** Display estimate: P1 for large samples, otherwise P5. */
export function achievementUnlockHours(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const denominator = sorted.length >= ACHIEVEMENT_UNLOCK_P1_MIN_SAMPLE ? 100 : 20;
  return sorted[Math.max(0, Math.ceil(sorted.length / denominator) - 1)] ?? null;
}
