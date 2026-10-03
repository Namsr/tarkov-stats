import { ComputeWorker } from "@/lib/compute-worker";
import { seasonalRiskInput, type evaluateAndStoreRisk } from "@/lib/admin/risk-service";
import type { SeasonalProfile } from "@/types/seasonal";

type Input = ReturnType<typeof seasonalRiskInput>;
type Result = Awaited<ReturnType<typeof evaluateAndStoreRisk>>;

export class SeasonalRiskWorker extends ComputeWorker<[Input], Result> {
  constructor(options: { entry?: string; timeoutMs?: number; maxPending?: number } = {}) {
    super({
      ...options,
      name: "Seasonal risk",
      entry: options.entry ?? "scripts/compute-risk-worker.mjs",
    });
  }
}

const worker = new SeasonalRiskWorker();
const pending = new Map<string, Promise<Result>>();

export function evaluateSeasonalRiskInBackground(profile: SeasonalProfile): Promise<Result> {
  const key = JSON.stringify([profile.cycleId, profile.aid, profile.profileUpdatedAt]);
  const existing = pending.get(key);
  if (existing) return existing;
  // Build the plain IPC payload here: raw Seasonal achievements can be
  // non-enumerable and would otherwise disappear when serializing the profile.
  const job = worker.compute(seasonalRiskInput(profile)).finally(() => pending.delete(key));
  pending.set(key, job);
  return job;
}
