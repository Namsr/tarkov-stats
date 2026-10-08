import { getStore, type PlayerStore } from "@/lib/db";
import { getArenaAverage, getArenaCohort } from "@/lib/arena/service";
import { computeSeasonalComparisonCohort } from "@/lib/seasonal/comparison-cohort";
import { computeSeasonalAverageCrossSection } from "@/lib/seasonal/average-db";

export type CohortJob =
  | { kind: "persistent"; mode: "regular" | "pve"; args: Parameters<PlayerStore["cohort2d"]> }
  | { kind: "arena"; args: Parameters<typeof getArenaCohort> }
  | { kind: "arena_population"; args: Parameters<typeof getArenaAverage> }
  | { kind: "seasonal"; args: Parameters<typeof computeSeasonalComparisonCohort> }
  | { kind: "seasonal_average"; args: Parameters<typeof computeSeasonalAverageCrossSection> };

export type CohortResults = {
  persistent: Awaited<ReturnType<PlayerStore["cohort2d"]>>;
  arena: Awaited<ReturnType<typeof getArenaCohort>>;
  arena_population: Awaited<ReturnType<typeof getArenaAverage>>;
  seasonal: Awaited<ReturnType<typeof computeSeasonalComparisonCohort>>;
  seasonal_average: Awaited<ReturnType<typeof computeSeasonalAverageCrossSection>>;
};

// Only the child calls these existing calculations. Keep SQL and cohort
// semantics in their current modules rather than duplicating them for IPC.
export async function computeCohort(job: CohortJob): Promise<CohortResults[keyof CohortResults]> {
  switch (job.kind) {
    case "persistent": {
      const store = await getStore(job.mode);
      if (!store) throw new Error("Comparison storage is unavailable");
      return store.cohort2d(...job.args);
    }
    case "arena": return getArenaCohort(...job.args);
    case "arena_population": return getArenaAverage(...job.args);
    case "seasonal": return computeSeasonalComparisonCohort(...job.args);
    case "seasonal_average": return computeSeasonalAverageCrossSection(...job.args);
  }
}
