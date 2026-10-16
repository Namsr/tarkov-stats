import { computeAverageMetricSeries } from "@/lib/average-metric-series";
import { getStore, type PlayerStore } from "@/lib/db";
import { getArenaAverage, getArenaCohort } from "@/lib/arena/service";
import { computeSeasonalComparisonCohort } from "@/lib/seasonal/comparison-cohort";
import { computeSeasonalAverageCrossSection } from "@/lib/seasonal/average-db";
import type { CrossSectionMode } from "@/lib/db";

export type CohortJob =
  | { kind: "average_metrics"; args: Parameters<typeof computeAverageMetricSeries> }
  | { kind: "persistent"; mode: "regular" | "pve"; args: Parameters<PlayerStore["cohort2d"]> }
  | { kind: "arena"; args: Parameters<typeof getArenaCohort> }
  | { kind: "arena_population"; args: Parameters<typeof getArenaAverage> }
  | { kind: "seasonal"; args: Parameters<typeof computeSeasonalComparisonCohort> }
  | { kind: "seasonal_average"; args: Parameters<typeof computeSeasonalAverageCrossSection> }
  | { kind: "baseline"; mode: CrossSectionMode; args: Parameters<PlayerStore["baseline"]> };

export type CohortResults = {
  average_metrics: Awaited<ReturnType<typeof computeAverageMetricSeries>>;
  persistent: Awaited<ReturnType<PlayerStore["cohort2d"]>>;
  arena: Awaited<ReturnType<typeof getArenaCohort>>;
  arena_population: Awaited<ReturnType<typeof getArenaAverage>>;
  seasonal: Awaited<ReturnType<typeof computeSeasonalComparisonCohort>>;
  seasonal_average: Awaited<ReturnType<typeof computeSeasonalAverageCrossSection>>;
  baseline: Awaited<ReturnType<PlayerStore["baseline"]>>;
};

// Only the child calls these existing calculations. Keep SQL and cohort
// semantics in their current modules rather than duplicating them for IPC.
export async function computeCohort(job: CohortJob): Promise<CohortResults[keyof CohortResults]> {
  switch (job.kind) {
    case "average_metrics": return computeAverageMetricSeries(...job.args);
    case "persistent": {
      const store = await getStore(job.mode);
      if (!store) throw new Error("Comparison storage is unavailable");
      return store.cohort2d(...job.args);
    }
    case "arena": return getArenaCohort(...job.args);
    case "arena_population": return getArenaAverage(...job.args);
    case "seasonal": return computeSeasonalComparisonCohort(...job.args);
    case "seasonal_average": return computeSeasonalAverageCrossSection(...job.args);
    case "baseline": {
      const store = await getStore(job.mode);
      if (!store) throw new Error("Baseline storage is unavailable");
      return store.baseline(...job.args);
    }
  }
}
