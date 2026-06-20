// What the /average histogram plots on the Y axis. The X axis is always the
// playtime bracket; this picks the bar height: either the player count in the
// bracket ("players") or the average of a metric column over that bracket.
//
// Each `column` is a real numeric column on the `players` table — the API
// whitelists requests against this list before any column reaches SQL.

export interface YMetric {
  /** Identity + query param value. */
  key: string;
  /** Label shown in the picker and as the Y-axis caption. */
  label: string;
  /** "count" = number of players; "avg" = average of `column`. */
  agg: "count" | "avg";
  /** Column to average (required when agg === "avg"). */
  column?: string;
  /** Decimal places for the value labels. */
  decimals?: number;
  /** Suffix for value labels, e.g. "%". */
  unit?: string;
}

export const Y_METRICS: YMetric[] = [
  { key: "players", label: "Players", agg: "count" },
  { key: "kd_ratio", label: "Avg K/D", agg: "avg", column: "kd_ratio", decimals: 2 },
  { key: "pmc_kd_ratio", label: "Avg PMC K/D", agg: "avg", column: "pmc_kd_ratio", decimals: 2 },
  { key: "survival_rate", label: "Avg survival", agg: "avg", column: "survival_rate", unit: "%", decimals: 1 },
  { key: "kills_per_raid", label: "Avg kills/raid", agg: "avg", column: "kills_per_raid", decimals: 2 },
  { key: "total_raids", label: "Avg raids", agg: "avg", column: "total_raids", decimals: 0 },
  { key: "total_kills", label: "Avg kills", agg: "avg", column: "total_kills", decimals: 0 },
  { key: "killed_pmc", label: "Avg PMC kills", agg: "avg", column: "killed_pmc", decimals: 0 },
  { key: "deaths", label: "Avg deaths", agg: "avg", column: "deaths", decimals: 0 },
  { key: "prestige", label: "Avg prestige", agg: "avg", column: "prestige", decimals: 2 },
  { key: "level", label: "Avg level", agg: "avg", column: "level", decimals: 0 },
  { key: "longest_win_streak", label: "Avg win streak", agg: "avg", column: "longest_win_streak", decimals: 1 },
  { key: "achv_count", label: "Avg achievements", agg: "avg", column: "achv_count", decimals: 1 },
];

export const DEFAULT_Y = "players";

export const Y_MAP = new Map(Y_METRICS.map((m) => [m.key, m]));

/** Resolves a (possibly untrusted) key to a known Y metric, falling back to the default. */
export function resolveY(key: string | null | undefined): YMetric {
  return (key && Y_MAP.get(key)) || Y_MAP.get(DEFAULT_Y)!;
}

/** Abbreviates a number with a 'k' suffix, trailing zeros trimmed: 1240 -> "1.2k", 1050 (2 dp) -> "1.05k". */
export function abbrevThousands(v: number, decimals = 1): string {
  return `${parseFloat((v / 1000).toFixed(decimals))}k`;
}

/** Formats a bar value, e.g. 1240 -> "1.2k", 1.24 -> "1.24", 41.3 -> "41.3%". */
export function formatValue(m: YMetric, v: number): string {
  const d = m.decimals ?? 0;
  let s: string;
  if (d === 0 && Math.abs(v) >= 1000) {
    s = abbrevThousands(v, 1);
  } else {
    s = v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  return m.unit ? `${s}${m.unit}` : s;
}
