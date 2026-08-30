const warmLoads = new Map<string, Promise<void>>();

function warmPaths(): string[] {
  const modes = ["regular", "pve"];
  const statistics = ["trimmed_mean", "median"];
  const periods = ["all", "90d"];
  const paths = statistics.flatMap((statistic) => modes.flatMap((mode) => periods.map((period) =>
    `/api/average?mode=${mode}&dimension=hours&metric=players&period=${period}&statistic=${statistic}`
  )));
  paths.push("/api/average/achievements?mode=regular", "/api/average/achievements?mode=pve");
  const cycle = process.env.SEASONAL_CYCLE_ID?.trim();
  if (process.env.SEASONAL_ENABLED === "true" && cycle) {
    for (const statistic of statistics) for (const period of periods) {
      paths.push(`/api/seasonal/average?cycle=${encodeURIComponent(cycle)}&dimension=hours&metric=players&period=${period}&statistic=${statistic}`);
    }
    paths.push(`/api/average/achievements?mode=seasonal&cycle=${encodeURIComponent(cycle)}`);
  }
  return paths;
}

/** Runs after the mutating response and deduplicates invalidations from a capture batch. */
export function warmAverageCaches(origin: string): Promise<void> {
  const normalized = origin.replace(/\/+$/, "");
  const existing = warmLoads.get(normalized);
  if (existing) return existing;
  const load = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    for (const path of warmPaths()) {
      try {
        const response = await fetch(`${normalized}${path}`, { headers: { accept: "application/json" } });
        await response.arrayBuffer();
      } catch (error) {
        console.warn(`average cache warm failed for ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  })().finally(() => {
    if (warmLoads.get(normalized) === load) warmLoads.delete(normalized);
  });
  warmLoads.set(normalized, load);
  return load;
}
