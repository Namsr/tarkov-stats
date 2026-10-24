/** Express the player's value as a fraction or multiple of the average. */
export function previewRatio(value: number | null, average: number | null): { direction: "above" | "below" | "equal"; ratio: number | null } | null {
  if (value === null || average === null || !Number.isFinite(value) || !Number.isFinite(average) || value < 0 || average < 0) return null;
  if (value === average) return { direction: "equal", ratio: 1 };
  const direction = value > average ? "above" : "below";
  return { direction, ratio: average > 0 ? value / average : null };
}

export const AXIS_PREVIEW_DELAY_MS = 180;
export const LEADERBOARD_PREVIEW_DELAY_MS = 400;
export const LEADERBOARD_PREVIEW_CLOSE_MS = 220;
