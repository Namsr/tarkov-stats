// Playtime (hours) bands shared by the /average page's range selector and the
// player comparison panel, so a player is always matched into the same bracket
// the averages are computed for.

export interface PlaytimeRange {
  label: string;
  min: number;
  /** null = open-ended top band. */
  max: number | null;
}

// Labels are unit-less (just the hour range); the localized "h"/"ч" unit is
// appended at render via t("unit.h") so the brackets read correctly in both
// languages.
export const PLAYTIME_RANGES: PlaytimeRange[] = [
  { label: "0–50", min: 0, max: 50 },
  { label: "50–100", min: 50, max: 100 },
  { label: "100–200", min: 100, max: 200 },
  { label: "200–500", min: 200, max: 500 },
  { label: "500–1000", min: 500, max: 1000 },
  { label: "1000–2000", min: 1000, max: 2000 },
  { label: "2000–5000", min: 2000, max: 5000 },
  { label: "5000+", min: 5000, max: null },
];

/** The playtime band a given number of hours falls into. */
export function rangeForHours(hours: number): PlaytimeRange {
  const h = Number.isFinite(hours) && hours > 0 ? hours : 0;
  return (
    PLAYTIME_RANGES.find((r) => h >= r.min && (r.max == null || h < r.max)) ??
    PLAYTIME_RANGES[0]
  );
}
