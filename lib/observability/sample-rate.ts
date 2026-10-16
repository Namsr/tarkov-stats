export function getObservabilitySampleRate(
  value: string | undefined = process.env.OBSERVABILITY_SAMPLE_RATE,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): number {
  const fallback = nodeEnv === "production" ? 0.05 : 0;
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : fallback;
}

/** Internal phase diagnostics share request sampling without analytics writes. */
export function logSampledTiming(
  timing: { outcome: "success" | "error"; totalMs: number },
): void {
  const rate = getObservabilitySampleRate();
  if (timing.outcome === "error" || timing.totalMs >= 1_000 || rate >= 1 || (rate > 0 && Math.random() < rate)) {
    console.log(JSON.stringify(timing));
  }
}
