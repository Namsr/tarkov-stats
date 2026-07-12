// Converts the API's fixed buckets into adaptive display bins. The chart can
// consume both the legacy playtime bracket keys and dimension-independent
// numeric buckets used for playtime and PMC raids.

import type { BracketAgg } from "@/lib/db";
import { abbrevThousands } from "@/lib/metrics";

export type { BracketAgg };

export interface BucketAgg {
  lo: number;
  hi: number | null;
  n: number;
  sum: number;
}

export interface HistBin {
  /** Inclusive lower bound. */
  lo: number;
  /** Exclusive upper bound, or null for an open-ended top bin. */
  hi: number | null;
  n: number;
  sum: number;
  label: string;
}

const MIN_BIN_COUNT = 5;
const MAX_BINS = 36;

function parseKey(key: string): { lo: number; hi: number | null } {
  if (key.endsWith("+")) return { lo: Number(key.slice(0, -1)), hi: null };
  const [lo, hi] = key.split("-");
  return { lo: Number(lo), hi: Number(hi) };
}

function formatBound(value: number): string {
  return value >= 1000 ? abbrevThousands(value, 2) : String(value);
}

function labelFor(lo: number, hi: number | null): string {
  return hi == null ? `${formatBound(lo)}+` : `${formatBound(lo)}–${formatBound(hi)}`;
}

type Cell = { lo: number; hi: number | null; n: number; sum: number };

function mergeToThreshold(cells: Cell[], minCount: number): HistBin[] {
  const bins: HistBin[] = [];
  let cursor = cells[0].lo;
  let hi: number | null = null;
  let n = 0;
  let sum = 0;

  for (const cell of cells) {
    hi = cell.hi;
    n += cell.n;
    sum += cell.sum;
    if (n >= minCount) {
      bins.push({ lo: cursor, hi, n, sum, label: labelFor(cursor, hi) });
      cursor = hi ?? cursor;
      n = 0;
      sum = 0;
    }
  }

  if (n > 0) {
    const last = bins[bins.length - 1];
    if (last) {
      last.hi = hi;
      last.n += n;
      last.sum += sum;
      last.label = labelFor(last.lo, last.hi);
    } else {
      bins.push({ lo: cursor, hi, n, sum, label: labelFor(cursor, hi) });
    }
  }

  return bins;
}

function build(cells: Cell[], maxBins: number): HistBin[] {
  const sorted = cells
    .filter(
      (cell) =>
        Number.isFinite(cell.lo) &&
        (cell.hi == null || (Number.isFinite(cell.hi) && cell.hi > cell.lo)) &&
        Number.isFinite(cell.n) &&
        Number.isFinite(cell.sum) &&
        cell.n > 0,
    )
    .sort((a, b) => a.lo - b.lo);

  if (sorted.length === 0) return [];

  const cap = Number.isFinite(maxBins)
    ? Math.max(1, Math.min(MAX_BINS, Math.floor(maxBins)))
    : MAX_BINS;
  let minCount = MIN_BIN_COUNT;
  let bins = mergeToThreshold(sorted, minCount);
  while (bins.length > cap && bins.length > 1) {
    minCount = Math.ceil(minCount * 1.5);
    bins = mergeToThreshold(sorted, minCount);
  }
  return bins;
}

export function buildHistogram(aggs: BracketAgg[], maxBins: number = MAX_BINS): HistBin[] {
  return build(
    aggs.map((bucket) => ({ ...parseKey(bucket.bracket_key), n: bucket.n, sum: bucket.sum })),
    maxBins,
  );
}

export function buildNumericHistogram(aggs: BucketAgg[], maxBins: number = MAX_BINS): HistBin[] {
  return build(
    aggs.map((bucket) => ({
      lo: Number(bucket.lo),
      hi: bucket.hi == null ? null : Number(bucket.hi),
      n: Number(bucket.n),
      sum: Number(bucket.sum),
    })),
    maxBins,
  );
}
