export interface Bracket {
  key: string;
  lo: number;
  /** null = open-ended top bracket */
  hi: number | null;
}

/** 50h-wide brackets up to here, 100h-wide above. */
const FINE_LIMIT = 2000;
const FINE_STEP = 50;
const COARSE_STEP = 100;
/** Everything at/above this collapses into one open-ended bracket. */
const TOP_CAP = 10000;

/**
 * Maps a playtime (hours) to its aggregation bracket:
 * 0-50, 50-100, ... 1950-2000, then 2000-2100, 2100-2200, ... up to a
 * single open-ended "10000+" bracket.
 */
export function bracketFor(hours: number): Bracket {
  const h = Number.isFinite(hours) && hours > 0 ? hours : 0;

  if (h >= TOP_CAP) {
    return { key: `${TOP_CAP}+`, lo: TOP_CAP, hi: null };
  }

  if (h < FINE_LIMIT) {
    const lo = Math.floor(h / FINE_STEP) * FINE_STEP;
    return { key: `${lo}-${lo + FINE_STEP}`, lo, hi: lo + FINE_STEP };
  }

  const lo = FINE_LIMIT + Math.floor((h - FINE_LIMIT) / COARSE_STEP) * COARSE_STEP;
  return { key: `${lo}-${lo + COARSE_STEP}`, lo, hi: lo + COARSE_STEP };
}
