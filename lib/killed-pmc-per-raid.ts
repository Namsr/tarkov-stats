/** Version 1 certifies the exact PMC-versus-PMC counter tuple. Zero is known data. */
export function killedPmcPerRaid(stats: {
  pmcKilledPmc?: unknown;
  pmcRaids?: unknown;
  pvpStatsVersion?: unknown;
  pvpStatsKnown?: unknown;
}): number | null {
  const { pmcKilledPmc: kills, pmcRaids: raids } = stats;
  if (stats.pvpStatsVersion !== 1 || stats.pvpStatsKnown === false ||
      typeof kills !== "number" || !Number.isFinite(kills) || kills < 0 ||
      typeof raids !== "number" || !Number.isFinite(raids) || raids <= 0) return null;
  const value = kills / raids;
  return Number.isFinite(value) ? value : null;
}
