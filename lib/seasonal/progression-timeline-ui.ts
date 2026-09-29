import type { ProgressionPoint } from "@/types/seasonal";

/** Break a line at wipe/reset boundaries and at non-finite values. */
export function progressionLineSegments(points: readonly ProgressionPoint[]): ProgressionPoint[][] {
  const segments: ProgressionPoint[][] = [];
  let breakNext = false;
  for (const point of points) {
    if (!Number.isFinite(point.pmcRaids) || !Number.isFinite(point.value)) {
      breakNext = true;
      continue;
    }
    const current = segments.at(-1);
    if (!current || breakNext) {
      segments.push([point]);
      breakNext = false;
      continue;
    }
    const previous = current.at(-1)!;
    if (previous.seriesId !== point.seriesId && (previous.seriesId != null || point.seriesId != null)) {
      segments.push([point]);
    } else {
      current.push(point);
    }
  }
  return segments;
}
