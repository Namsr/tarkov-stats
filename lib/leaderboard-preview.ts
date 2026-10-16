/** Both ratios are expressed as a positive multiplier: 1 / 2 is "2× below". */
export function previewRatio(value: number | null, average: number | null): { direction: "above" | "below" | "equal"; ratio: number | null } | null {
  if (value === null || average === null || !Number.isFinite(value) || !Number.isFinite(average) || value < 0 || average < 0) return null;
  if (value === average) return { direction: "equal", ratio: 1 };
  const direction = value > average ? "above" : "below";
  const lower = Math.min(value, average);
  return { direction, ratio: lower > 0 ? Math.max(value, average) / lower : null };
}

export const LEADERBOARD_PREVIEW_DELAY_MS = 400;
export const LEADERBOARD_PREVIEW_CLOSE_MS = 220;
