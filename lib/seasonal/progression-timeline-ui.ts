import type { ProgressionPoint } from "@/types/seasonal";

export interface RaidDomain {
  min: number;
  max: number;
}

export interface ValueDomain {
  min: number;
  max: number;
}

export const PROGRESSION_DAY_MS = 86_400_000;

function moscowDateParts(timestamp: number): { year: string; month: string; day: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));
  return {
    year: parts.find((part) => part.type === "year")?.value ?? "1970",
    month: parts.find((part) => part.type === "month")?.value ?? "01",
    day: parts.find((part) => part.type === "day")?.value ?? "01",
  };
}

export function progressionDayStart(timestamp: number): number {
  const { year, month, day } = moscowDateParts(timestamp);
  return Date.parse(`${year}-${month}-${day}T00:00:00+03:00`);
}

/** Resolve the horizontal day coordinate used by the timeline. */
export function progressionPointDay(point: Pick<ProgressionPoint, "date" | "observedAt">): number | null {
  if (Number.isFinite(point.observedAt)) return Number(point.observedAt);
  const parsed = Date.parse(`${point.date}T00:00:00+03:00`);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Calculate a padded timestamp domain, optionally focused on the player's own snapshots. */
export function progressionDayDomain(
  points: readonly ProgressionPoint[],
  playerPoints: readonly ProgressionPoint[] = points,
  focusPlayer = false,
  cycleStartsAt: number | null = null,
): RaidDomain {
  const finite = (source: readonly ProgressionPoint[]) => source
    .map(progressionPointDay)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const allDays = finite(points);
  const playerDays = finite(playerPoints);
  const source = focusPlayer && playerDays.length > 0 ? playerDays : allDays;
  if (source.length === 0) {
    const cycleStart = Number.isFinite(cycleStartsAt) ? progressionDayStart(Number(cycleStartsAt)) : null;
    return cycleStart == null
      ? { min: 0, max: PROGRESSION_DAY_MS }
      : { min: cycleStart, max: cycleStart + PROGRESSION_DAY_MS };
  }
  const rawMin = Math.min(...source);
  const rawMax = Math.max(...source);
  const span = Math.max(PROGRESSION_DAY_MS, rawMax - rawMin);
  const padding = focusPlayer ? Math.max(PROGRESSION_DAY_MS, span * 0.1) : 0;
  const cycleStart = Number.isFinite(cycleStartsAt) ? progressionDayStart(Number(cycleStartsAt)) : null;
  const min = cycleStart != null && !focusPlayer
    ? cycleStart
    : progressionDayStart(rawMin - padding);
  const max = progressionDayStart(rawMax + padding + PROGRESSION_DAY_MS);
  return { min, max: max > min ? max : min + PROGRESSION_DAY_MS };
}

export function progressionDayTicks(minDay: number, maxDay: number, maxTicks = 8): number[] {
  if (!(maxDay > minDay)) return [minDay];
  const spanDays = Math.max(1, Math.ceil((maxDay - minDay) / PROGRESSION_DAY_MS));
  const stepDays = Math.max(1, Math.ceil(spanDays / Math.max(1, maxTicks - 1)));
  const start = minDay;
  const ticks = Array.from(
    { length: Math.floor((maxDay - start) / (stepDays * PROGRESSION_DAY_MS)) + 1 },
    (_, index) => start + index * stepDays * PROGRESSION_DAY_MS,
  );
  return ticks.length > 0 ? ticks : [minDay, maxDay];
}

/** Keep all x-axis math in one place so full and focused views stay consistent. */
export function progressionRaidDomain(
  points: readonly ProgressionPoint[],
  playerPoints: readonly ProgressionPoint[] = points,
  focusPlayer = false,
): RaidDomain {
  const finite = (source: readonly ProgressionPoint[]) => source
    .map((point) => point.pmcRaids)
    .filter(Number.isFinite);
  const allRaids = finite(points);
  const playerRaids = finite(playerPoints);
  const source = focusPlayer && playerRaids.length > 0 ? playerRaids : allRaids;
  const maxRaid = source.length ? Math.max(...source) : 0;
  if (focusPlayer && playerRaids.length > 0) {
    const minRaid = Math.min(...playerRaids);
    const range = Math.max(1, maxRaid - minRaid);
    const padding = Math.max(10, range * 0.1);
    return {
      min: Math.max(0, Math.floor((minRaid - padding) / 10) * 10),
      max: Math.max(
        Math.ceil((maxRaid + padding) / 10) * 10,
        Math.max(0, Math.floor((minRaid - padding) / 10) * 10) + 10,
      ),
    };
  }
  const roundedMax = Math.max(10, Math.ceil(maxRaid / 10) * 10);
  return { min: 0, max: roundedMax };
}

/** Compute an independent, padded Y domain from the real values in one metric. */
export function progressionValueDomain(
  points: readonly ProgressionPoint[],
  percent = false,
): ValueDomain {
  const values = points
    .map((point) => point.value)
    .filter(Number.isFinite)
    .map((value) => percent ? Math.min(100, Math.max(0, value)) : value);
  if (values.length === 0) return percent ? { min: 0, max: 100 } : { min: 0, max: 1 };
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const span = rawMax - rawMin;
  const padding = span > 0 ? span * 0.08 : Math.max(1, Math.abs(rawMax) * 0.08);
  const min = rawMin - padding;
  const max = rawMax + padding;
  if (percent) {
    const boundedMin = Math.max(0, min);
    const boundedMax = Math.min(100, Math.max(0, max));
    return {
      min: boundedMin,
      max: boundedMax > boundedMin ? boundedMax : Math.min(100, boundedMin + 1),
    };
  }
  return { min, max: max === min ? min + 1 : max };
}

/** Keep comparison lines and their Y-domains inside the current raid window. */
export function progressionPointsInRaidDomain(
  points: readonly ProgressionPoint[],
  domain: RaidDomain,
): ProgressionPoint[] {
  return points.filter((point) =>
    Number.isFinite(point.pmcRaids) &&
    Number.isFinite(point.value) &&
    (point.raidMax ?? point.pmcRaids) >= domain.min &&
    (point.raidMin ?? point.pmcRaids) <= domain.max,
  );
}

export function progressionPointsInDayDomain(
  points: readonly ProgressionPoint[],
  domain: RaidDomain,
): ProgressionPoint[] {
  return points.filter((point) => {
    const day = progressionPointDay(point);
    return Number.isFinite(point.value) && day != null && day >= domain.min && day <= domain.max;
  });
}

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

export function timelinePointLabelValue(value: number, percent = false): string {
  if (!Number.isFinite(value)) return "—";
  return percent
    ? `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
    : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
