// @ts-expect-error Workers scheduled runtime imports the explicit source extension.
import { refreshD1SeasonalAggregates } from "./daily-aggregates.ts";
// @ts-expect-error Workers scheduled runtime imports the explicit source extension.
import { materializeD1PopulationSnapshot } from "./progression-db.ts";
import type { D1DatabaseLike } from "./d1";

export interface ProgressionSchedulerEnv {
  DB?: D1DatabaseLike;
  SEASONAL_ENABLED?: string;
  SEASONAL_CYCLE_ID?: string;
}

export async function materializeScheduledD1Population(
  env: ProgressionSchedulerEnv,
  scheduledAt = Date.now(),
) {
  const cycleId = env.SEASONAL_CYCLE_ID?.trim();
  if (!env.DB || env.SEASONAL_ENABLED !== "true" || !cycleId) return { skipped: true } as const;
  await refreshD1SeasonalAggregates(env.DB, cycleId);
  return { skipped: false, ...(await materializeD1PopulationSnapshot(env.DB, "seasonal", cycleId, scheduledAt)) } as const;
}
