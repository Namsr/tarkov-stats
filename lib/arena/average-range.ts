export interface ArenaRangeBounds {
  min: number;
  max: number;
}

export interface ArenaRangeSelection {
  low: number;
  high: number;
}

export interface ArenaHistogramSlice {
  left: number;
  width: number;
}

type ArenaBucket = { min: number; max: number | null };
type ArenaRangeEdge = "low" | "high";

export function isArenaRangeBounds(value: { min: number | null; max: number | null } | null | undefined): value is ArenaRangeBounds {
  const min = value?.min;
  const max = value?.max;
  return Boolean(
    typeof min === "number" &&
      typeof max === "number" &&
      Number.isFinite(min) &&
      Number.isFinite(max) &&
      min >= 0 &&
      max > min,
  );
}

function clamp(value: number, bounds: ArenaRangeBounds): number {
  return Math.min(bounds.max, Math.max(bounds.min, value));
}

function endPadding(bounds: ArenaRangeBounds, discrete: boolean): number {
  return discrete ? 1 : Math.max(Number.EPSILON, (bounds.max - bounds.min) / 10_000);
}

function visibleBuckets(buckets: readonly ArenaBucket[], bounds: ArenaRangeBounds, discrete: boolean) {
  const end = bounds.max + endPadding(bounds, discrete);
  return buckets.map((bucket) => ({
    start: Math.max(bucket.min, bounds.min),
    end: Math.min(bucket.max ?? end, end),
  })).filter((bucket) => bucket.end > bucket.start);
}

export function arenaRangeSelection(
  bounds: ArenaRangeBounds,
  low: number | null,
  high: number | null,
): ArenaRangeSelection {
  const nextLow = clamp(low ?? bounds.min, bounds);
  const nextHigh = clamp(high ?? bounds.max, bounds);
  return nextLow <= nextHigh
    ? { low: nextLow, high: nextHigh }
    : { low: nextHigh, high: nextLow };
}

/** Restores open-ended URL filters when a slider thumb reaches the full domain edge. */
export function arenaRangeFilterValue(value: number, bounds: ArenaRangeBounds, edge: "low" | "high"): string {
  if (value === (edge === "low" ? bounds.min : bounds.max)) return "";
  return String(clamp(value, bounds));
}

/** Matches the slider track to equal-width rendered columns, including their gaps. */
export function arenaBucketPosition(
  buckets: readonly ArenaBucket[],
  bounds: ArenaRangeBounds,
  value: number,
  edge: ArenaRangeEdge,
  discrete: boolean,
  chartWidth: number,
  gap: number,
): number {
  const visible = visibleBuckets(buckets, bounds, discrete);
  if (!visible.length) return 0;
  const padding = endPadding(bounds, discrete);
  const target = edge === "high" ? value + padding : value;
  if (target <= visible[0].start) return 0;
  if (target >= visible[visible.length - 1].end) return 1;
  const width = Math.max(1, chartWidth);
  const actualGap = chartWidth > 0 ? gap : 0;
  const barWidth = Math.max(0, (width - actualGap * (visible.length - 1)) / visible.length);
  for (let index = 0; index < visible.length; index += 1) {
    const bucket = visible[index];
    if (index > 0 && target <= bucket.start) {
      return (index * (barWidth + actualGap) - (edge === "high" ? actualGap : 0)) / width;
    }
    if (target < bucket.end || (edge === "high" && target === bucket.end)) {
      const fraction = Math.min(1, Math.max(0, (target - bucket.start) / (bucket.end - bucket.start)));
      return (index * (barWidth + actualGap) + fraction * barWidth) / width;
    }
  }
  return 1;
}

/** Inverse of arenaBucketPosition for range thumb movement through bars and gaps. */
export function arenaBucketValueAtPosition(
  buckets: readonly ArenaBucket[],
  bounds: ArenaRangeBounds,
  position: number,
  edge: ArenaRangeEdge,
  discrete: boolean,
  chartWidth: number,
  gap: number,
): number {
  const visible = visibleBuckets(buckets, bounds, discrete);
  if (!visible.length) return edge === "low" ? bounds.min : bounds.max;
  const padding = endPadding(bounds, discrete);
  const width = Math.max(1, chartWidth);
  const actualGap = chartWidth > 0 ? gap : 0;
  const barWidth = Math.max(0, (width - actualGap * (visible.length - 1)) / visible.length);
  const cellWidth = barWidth + actualGap;
  const pixel = Math.min(width, Math.max(0, position * width));
  const index = Math.min(visible.length - 1, Math.floor(pixel / Math.max(1, cellWidth)));
  const bucket = visible[index];
  const offset = pixel - index * cellWidth;
  if (offset > barWidth && index < visible.length - 1) {
    const boundary = edge === "low" ? visible[index + 1].start : bucket.end;
    return clamp(discrete && edge === "high" ? Math.round(boundary) - 1 : edge === "high" ? boundary - padding : boundary, bounds);
  }
  const fraction = Math.min(1, Math.max(0, offset / Math.max(1, barWidth)));
  const boundary = bucket.start + fraction * (bucket.end - bucket.start);
  const value = discrete && edge === "high" ? Math.round(boundary) - 1 : discrete ? Math.round(boundary) : edge === "high" ? boundary - padding : boundary;
  return clamp(value, bounds);
}

/** Selected fraction of a visible bucket, restricted to the slider's stable domain. */
export function arenaHistogramSlice(
  bucket: ArenaBucket,
  selection: ArenaRangeSelection,
  bounds: ArenaRangeBounds,
  discrete: boolean,
): ArenaHistogramSlice {
  const padding = endPadding(bounds, discrete);
  const bucketStart = Math.max(bucket.min, bounds.min);
  const bucketEnd = Math.min(bucket.max ?? bounds.max + padding, bounds.max + padding);
  const width = Math.max(Number.EPSILON, bucketEnd - bucketStart);
  const selectedStart = Math.max(bucketStart, selection.low);
  const selectedEnd = Math.min(bucketEnd, selection.high >= bounds.max ? bucketEnd : selection.high + padding);
  const overlap = Math.max(0, selectedEnd - selectedStart);
  return {
    left: Math.min(100, Math.max(0, ((selectedStart - bucketStart) / width) * 100)),
    width: Math.min(100, Math.max(0, (overlap / width) * 100)),
  };
}
