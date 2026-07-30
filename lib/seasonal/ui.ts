export interface ChartDatum {
  seasonDay: number;
  value: number;
  seriesId?: number | null;
}

export interface LevelBand {
  level: number;
  experience: number;
}

export interface ChartBounds {
  minDay: number;
  maxDay: number;
  minValue: number;
  maxValue: number;
}

export function raidTicks(minRaid: number, maxRaid: number, maxTicks = 8): number[] {
  const start = Math.max(10, Math.ceil(minRaid / 10) * 10);
  const end = Math.floor(maxRaid / 10) * 10;
  if (end < start) return [];
  const count = Math.floor((end - start) / 10) + 1;
  const step = Math.max(10, Math.ceil(count / maxTicks) * 10);
  return Array.from({ length: Math.floor((end - start) / step) + 1 }, (_, index) => start + index * step);
}

export function populationWithinPlayerRaidRange<T extends { pmcRaids: number }>(
  points: readonly T[],
  player: readonly T[],
  averageOnly = false,
): readonly T[] {
  if (averageOnly || player.length === 0) return points;
  const maxRaid = Math.ceil(Math.max(...player.map((point) => point.pmcRaids)) / 10) * 10;
  return points.filter((point) => point.pmcRaids >= 10 && point.pmcRaids <= maxRaid);
}

export function chartBounds(series: readonly (readonly ChartDatum[])[], include = 0): ChartBounds {
  const points = series.flat();
  const days = points.map((point) => point.seasonDay).filter(Number.isFinite);
  const values = points.map((point) => point.value).filter(Number.isFinite);
  const minDay = days.length ? Math.min(...days) : 1;
  const maxDay = days.length ? Math.max(...days) : minDay + 1;
  const minValue = Math.min(include, ...(values.length ? values : [include]));
  const rawMax = Math.max(include, ...(values.length ? values : [include + 1]));
  return {
    minDay,
    maxDay: maxDay === minDay ? minDay + 1 : maxDay,
    minValue,
    maxValue: rawMax === minValue ? minValue + 1 : rawMax,
  };
}

export function chartPath(
  points: readonly ChartDatum[],
  bounds: ChartBounds,
  width: number,
  height: number,
): string {
  const x = (day: number) => ((day - bounds.minDay) / (bounds.maxDay - bounds.minDay)) * width;
  const y = (value: number) =>
    height - ((value - bounds.minValue) / (bounds.maxValue - bounds.minValue)) * height;
  return points
    .filter((point) => Number.isFinite(point.seasonDay) && Number.isFinite(point.value))
    .map((point, index, valid) => {
      const previous = valid[index - 1];
      const beginsSeries = index === 0 || (
        point.seriesId != null && previous?.seriesId != null && point.seriesId !== previous.seriesId
      );
      return `${beginsSeries ? "M" : "L"}${x(point.seasonDay).toFixed(2)},${y(point.value).toFixed(2)}`;
    })
    .join(" ");
}

/** Convert incremental player-level requirements to cumulative XP boundaries. */
export function cumulativeLevelBands(levels: readonly { level: number; exp: number }[]): LevelBand[] {
  let experience = 0;
  return [...levels]
    .filter((entry) => Number.isFinite(entry.level) && Number.isFinite(entry.exp) && entry.exp >= 0)
    .sort((a, b) => a.level - b.level)
    .map((entry) => {
      experience += entry.exp;
      return { level: entry.level, experience };
    });
}

export function levelAtExperience(experience: number, bands: readonly LevelBand[]): number {
  let level = 0;
  for (const band of bands) {
    if (experience < band.experience) break;
    level = band.level;
  }
  return level;
}

export function spacedLevelLabels(
  bands: readonly LevelBand[],
  minValue: number,
  maxValue: number,
  height: number,
  minGap = 17,
): LevelBand[] {
  if (!(maxValue > minValue) || height <= 0 || minGap < 0) return [];
  const y = (band: LevelBand) =>
    height - ((band.experience - minValue) / (maxValue - minValue)) * height;
  const kept: LevelBand[] = [];
  for (const band of [...bands].sort((left, right) =>
    right.level - left.level || right.experience - left.experience
  )) {
    if (kept.every((existing) => Math.abs(y(band) - y(existing)) >= minGap)) kept.push(band);
  }
  return kept;
}

export function xpPerDay(points: readonly ({ value: number } & ({ seasonDay: number } | { date: string }))[]): number | null {
  if (points.length < 2) return null;
  const day = (point: { seasonDay: number } | { date: string }) => "seasonDay" in point
    ? point.seasonDay
    : Date.parse(`${point.date}T00:00:00Z`) / 86_400_000;
  const sorted = [...points].sort((a, b) => day(a) - day(b));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const days = day(last) - day(first);
  return days > 0 ? (last.value - first.value) / days : null;
}
