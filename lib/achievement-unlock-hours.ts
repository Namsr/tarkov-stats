export const ACHIEVEMENT_UNLOCK_P1_MIN_SAMPLE = 500;

/** Display estimate: P1 for large samples, otherwise P5. */
export function achievementUnlockHours(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const denominator = sorted.length >= ACHIEVEMENT_UNLOCK_P1_MIN_SAMPLE ? 100 : 20;
  return sorted[Math.max(0, Math.ceil(sorted.length / denominator) - 1)] ?? null;
}
