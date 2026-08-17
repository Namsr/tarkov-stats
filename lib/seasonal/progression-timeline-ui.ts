import type { ProgressionPoint } from "@/types/seasonal";

export interface RaidDomain {
  min: number;
  max: number;
}

export interface ValueDomain {
  min: number;
  max: number;
}

export interface MetricDomainSample {
  value: number;
  referenceY: number | null;
}

export interface MetricDomainResolution {
  domain: ValueDomain;
  unresolved: number[];
}

const METRIC_DOMAIN_EXPANSION_STEPS = [0, 0.05, 0.1, 0.15, 0.2, 0.25] as const;

function metricYForDomain(value: number, domain: ValueDomain, plotHeight: number): number {
  return plotHeight - ((value - domain.min) / Math.max(1e-9, domain.max - domain.min)) * plotHeight;
}

export function metricCollisionRingRadius(
  centerDistancePx: number,
  referenceRadiusPx = 7,
  strokeWidthPx = 1.75,
  gapPx = 1,
): number {
  const distance = Number.isFinite(centerDistancePx) ? Math.max(0, centerDistancePx) : 0;
  const referenceRadius = Number.isFinite(referenceRadiusPx) ? Math.max(0, referenceRadiusPx) : 0;
  const strokeWidth = Number.isFinite(strokeWidthPx) ? Math.max(0, strokeWidthPx) : 0;
  const gap = Number.isFinite(gapPx) ? Math.max(0, gapPx) : 0;
  return Math.ceil(distance + referenceRadius + strokeWidth / 2 + gap);
}

export interface MarkerCollisionSample {
  id: string;
  x: number | null;
  y: number;
  outerRadiusPx?: number;
}

/** Assign nested rings in render order while keeping every marker at its exact value. */
export function markerCollisionRingRadii(
  samples: readonly MarkerCollisionSample[],
  clearancePx = 14,
  strokeWidthPx = 1.75,
  gapPx = 1,
): Record<string, number> {
  const rings: Record<string, number> = {};
  const placed: Array<MarkerCollisionSample & { outerRadiusPx: number }> = [];
  const clearance = Number.isFinite(clearancePx) ? Math.max(0, clearancePx) : 14;
  const strokeWidth = Number.isFinite(strokeWidthPx) ? Math.max(0, strokeWidthPx) : 0;
  const gap = Number.isFinite(gapPx) ? Math.max(0, gapPx) : 0;

  for (const sample of samples) {
    if (sample.x == null || !Number.isFinite(sample.x) || !Number.isFinite(sample.y)) continue;
    const references = placed.filter((candidate) =>
      Math.hypot(sample.x! - candidate.x!, sample.y - candidate.y) < clearance,
    );
    let outerRadius = Number.isFinite(sample.outerRadiusPx)
      ? Math.max(0, Number(sample.outerRadiusPx))
      : 7;
    if (references.length > 0) {
      const requiredInnerRadius = Math.max(...references.map((candidate) =>
        Math.hypot(sample.x! - candidate.x!, sample.y - candidate.y) + candidate.outerRadiusPx));
      const ringRadius = Math.ceil(requiredInnerRadius + strokeWidth / 2 + gap);
      rings[sample.id] = ringRadius;
      outerRadius = ringRadius + strokeWidth / 2;
    }
    placed.push({ ...sample, outerRadiusPx: outerRadius });
  }

  return rings;
}

/**
 * Choose the smallest deterministic shared metric domain that separates player
 * metric samples from their left-axis reference points. Aggregate series are
 * intentionally absent from the input so they cannot move the player's axis.
 */
export function resolveMetricDomain(
  baseDomain: ValueDomain,
  samples: readonly MetricDomainSample[],
  plotHeight: number,
  options: { percent?: boolean; clearancePx?: number } = {},
): MetricDomainResolution {
  const finiteSamples = samples
    .map((sample, index) => ({ sample, index }))
    .filter(({ sample }) => Number.isFinite(sample.value));
  const finiteValues = finiteSamples.map(({ sample }) => sample.value);
  const percent = options.percent === true;
  const clearancePx = Number.isFinite(options.clearancePx) ? Math.max(0, Number(options.clearancePx)) : 14;
  const safeHeight = Number.isFinite(plotHeight) && plotHeight > 0 ? plotHeight : 1;
  const min = percent
    ? Math.max(0, Math.min(baseDomain.min, ...finiteValues))
    : Math.min(baseDomain.min, ...finiteValues);
  const max = percent
    ? Math.min(100, Math.max(baseDomain.max, ...finiteValues))
    : Math.max(baseDomain.max, ...finiteValues);
  const span = max > min ? max - min : 1;
  const candidates = METRIC_DOMAIN_EXPANSION_STEPS.flatMap((lowerExpansion) =>
    METRIC_DOMAIN_EXPANSION_STEPS.map((upperExpansion) => ({
      domain: {
        min: percent ? Math.max(0, min - span * lowerExpansion) : min - span * lowerExpansion,
        max: percent ? Math.min(100, max + span * upperExpansion) : max + span * upperExpansion,
      },
      expansion: lowerExpansion + upperExpansion,
      lowerExpansion,
      upperExpansion,
    })),
  );

  const score = (candidate: (typeof candidates)[number]) => {
    const unresolved = finiteSamples
      .filter(({ sample }) => sample.referenceY != null && Math.abs(metricYForDomain(sample.value, candidate.domain, safeHeight) - sample.referenceY!) < clearancePx)
      .map(({ index }) => index);
    return { candidate, unresolved };
  };
  const best = candidates.map(score).reduce((current, next) => {
    if (next.unresolved.length < current.unresolved.length) return next;
    if (next.unresolved.length > current.unresolved.length) return current;
    if (next.candidate.expansion < current.candidate.expansion) return next;
    if (next.candidate.expansion > current.candidate.expansion) return current;
    if (next.candidate.lowerExpansion < current.candidate.lowerExpansion) return next;
    return current;
  });

  return { domain: best.candidate.domain, unresolved: best.unresolved };
}

export const PROGRESSION_DAY_MS = 86_400_000;

function average(values: readonly (number | null | undefined)[]): number | null {
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

function combineProgressionBucket(points: readonly ProgressionPoint[]): ProgressionPoint {
  const first = points[0]!;
  const last = points.at(-1)!;
  const value = average(points.map((point) => point.value)) ?? first.value;
  const pmcRaids = Math.round(average(points.map((point) => point.pmcRaids)) ?? first.pmcRaids);
  const observedAt = average(points.map((point) => point.observedAt));
  const averageLevel = average(points.map((point) => point.level));
  const p25 = average(points.map((point) => point.p25));
  const p75 = average(points.map((point) => point.p75));
  const sampleN = average(points.map((point) => point.sampleN));
  return {
    ...last,
    pointId: `combined:${first.pointId}:${last.pointId}`,
    observedAt,
    pmcRaids,
    ...(averageLevel == null ? {} : { level: Math.round(averageLevel) }),
    raidMin: Math.min(...points.map((point) => point.raidMin ?? point.pmcRaids)),
    raidMax: Math.max(...points.map((point) => point.raidMax ?? point.pmcRaids)),
    periodStartAt: first.periodStartAt ?? null,
    elapsedDays: null,
    deltaExperience: null,
    deltaPmcRaids: null,
    value,
    p25,
    p75,
    n: Math.round(average(points.map((point) => point.n)) ?? first.n),
    sampleN: sampleN == null ? null : Math.round(sampleN),
    preliminary: points.some((point) => point.preliminary),
    confidence: average(points.map((point) => point.confidence)) ?? first.confidence,
  };
}

/**
 * Keep aggregate chart series readable and cheap to interact with. Exact player
 * history is never passed here. Endpoints and reset boundaries stay distinct;
 * only adjacent population raid buckets are averaged together.
 */
export function compactProgressionPoints(
  points: readonly ProgressionPoint[],
  maxPoints = 48,
): ProgressionPoint[] {
  const finite = points.filter((point) => Number.isFinite(point.pmcRaids) && Number.isFinite(point.value));
  if (finite.length <= maxPoints || maxPoints < 3) return [...finite];
  const first = finite[0]!;
  const last = finite.at(-1)!;
  const interior = finite.slice(1, -1);
  const groupSize = Math.ceil(interior.length / (maxPoints - 2));
  const compacted: ProgressionPoint[] = [first];
  for (let index = 0; index < interior.length; index += groupSize) {
    const group = interior.slice(index, index + groupSize);
    let start = 0;
    for (let cursor = 1; cursor <= group.length; cursor += 1) {
      const previous = group[cursor - 1];
      const current = group[cursor];
      const boundary = cursor === group.length ||
        (previous?.seriesId !== current?.seriesId && (previous?.seriesId != null || current?.seriesId != null));
      if (!boundary) continue;
      compacted.push(combineProgressionBucket(group.slice(start, cursor)));
      start = cursor;
    }
  }
  compacted.push(last);
  return compacted;
}

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
