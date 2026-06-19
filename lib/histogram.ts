// Turns the fixed 50h/100h playtime brackets stored in the DB into an *adaptive*
// histogram for display: when there are few players the bars span wide playtime
// ranges (e.g. 0–1000, 1000–3000); as the sample grows the bars split apart and
// converge toward the underlying 50h resolution.
//
// Each bar carries both a player count and the SUM of the selected metric over
// its players, so the caller can show either the count or a weighted average.
// The X axis is always playtime; columns render at equal width.

export interface BracketAgg {
  /** Playtime bracket, e.g. "0-50" or "10000+". */
  bracket_key: string;
  /** Players in the bracket. */
  n: number;
  /** SUM of the selected metric over the bracket. */
  sum: number;
}

export interface HistBin {
  /** Inclusive lower hour bound. */
  lo: number;
  /** Exclusive upper hour bound, or null for the open-ended top bin. */
  hi: number | null;
  /** Players pooled into the bar. */
  n: number;
  /** SUM of the selected metric over the pooled players. */
  sum: number;
  /** Playtime range label, e.g. "1k–3k". */
  label: string;
}

/** Each displayed bar should pool at least this many players before it splits. */
const MIN_BIN_COUNT = 5;
/** Hard cap on bars so the chart stays readable; threshold is raised to fit. */
const MAX_BINS = 36;

function parseKey(key: string): { lo: number; hi: number | null } {
  if (key.endsWith("+")) return { lo: Number(key.slice(0, -1)), hi: null };
  const [a, b] = key.split("-");
  return { lo: Number(a), hi: Number(b) };
}

function formatHours(h: number): string {
  if (h >= 1000) {
    const k = h / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return String(h);
}

function labelFor(lo: number, hi: number | null): string {
  return hi == null ? `${formatHours(lo)}+` : `${formatHours(lo)}–${formatHours(hi)}`;
}

type Cell = { lo: number; hi: number | null; n: number; sum: number };

/**
 * Greedily pool adjacent brackets left-to-right until each bar clears minCount.
 * Bars tile the axis continuously: each bar's lower edge is the previous bar's
 * upper edge, so an empty gap between populated brackets is absorbed rather than
 * shown as a hole.
 */
function mergeToThreshold(cells: Cell[], minCount: number): HistBin[] {
  const bins: HistBin[] = [];
  let cursor = cells[0].lo; // contiguous lower edge for the next bar
  let hi: number | null = null;
  let n = 0;
  let sum = 0;

  for (const c of cells) {
    hi = c.hi;
    n += c.n;
    sum += c.sum;
    if (n >= minCount) {
      bins.push({ lo: cursor, hi, n, sum, label: labelFor(cursor, hi) });
      cursor = hi ?? cursor;
      n = 0;
      sum = 0;
    }
  }

  // A sub-threshold remainder folds into the previous bar rather than dangling.
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

/**
 * Builds the adaptive histogram from the DB's per-bracket aggregates. Empty
 * brackets are simply absent from the input (so gaps collapse), and the bin
 * resolution adapts to how much data exists.
 */
export function buildHistogram(aggs: BracketAgg[]): HistBin[] {
  const cells = aggs
    .map((b) => ({ ...parseKey(b.bracket_key), n: b.n, sum: b.sum }))
    .filter((c) => Number.isFinite(c.lo) && c.n > 0)
    .sort((a, b) => a.lo - b.lo);

  if (cells.length === 0) return [];

  let minCount = MIN_BIN_COUNT;
  let bins = mergeToThreshold(cells, minCount);
  while (bins.length > MAX_BINS) {
    minCount = Math.ceil(minCount * 1.5);
    bins = mergeToThreshold(cells, minCount);
  }
  return bins;
}
