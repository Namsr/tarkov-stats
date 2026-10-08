import { ComputeWorker } from "@/lib/compute-worker";
import { seasonalRiskInput, type evaluateAndStoreRisk } from "@/lib/admin/risk-service";
import type { SeasonalProfile } from "@/types/seasonal";

type Input = ReturnType<typeof seasonalRiskInput>;
type Result = Awaited<ReturnType<typeof evaluateAndStoreRisk>>;
export type RegularRiskInput = Omit<Parameters<typeof evaluateAndStoreRisk>[0], "mode" | "playerStore"> & { mode: "regular" };

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

export class RegularRiskWorker extends ComputeWorker<[RegularRiskInput], Result> {
  constructor(options: { entry?: string; timeoutMs?: number; maxPending?: number } = {}) {
    super({ ...options, name: "Regular risk", entry: options.entry ?? "scripts/compute-risk-worker.mjs" });
  }
}

/** One job per account; updates arriving during a calculation replace its follow-up. */
export class RegularRiskScheduler {
  private readonly pending = new Map<string, { input: RegularRiskInput; promise: Promise<Result> }>();
  private readonly compute: (input: RegularRiskInput) => Promise<Result>;

  constructor(compute: (input: RegularRiskInput) => Promise<Result>) { this.compute = compute; }

  evaluate(input: RegularRiskInput): Promise<Result> {
    const key = JSON.stringify([input.aid, input.cycleId ?? "persistent"]);
    const existing = this.pending.get(key);
    if (existing) {
      const previous = existing.input.stats;
      const next = input.stats;
      if (Number(next.profileUpdatedAt ?? 0) > Number(previous.profileUpdatedAt ?? 0) ||
          Number(next.profileUpdatedAt ?? 0) === Number(previous.profileUpdatedAt ?? 0) &&
          Number(next.pvpStatsParserVersion ?? 0) > Number(previous.pvpStatsParserVersion ?? 0)) {
        existing.input = { ...input, queuedAt: Date.now() };
      }
      return existing.promise;
    }
    const job = { input: { ...input, queuedAt: Date.now() }, promise: undefined as unknown as Promise<Result> };
    // Defer dispatch until the map contains the job, including synchronous failures.
    job.promise = Promise.resolve().then(async () => {
      for (;;) {
        const current = job.input;
        try {
          const result = await this.compute(current);
          if (job.input === current) {
            this.pending.delete(key);
            return result;
          }
        } catch (error) {
          if (job.input === current) {
            this.pending.delete(key);
            throw error;
          }
        }
      }
    }).finally(() => { if (this.pending.get(key) === job) this.pending.delete(key); });
    this.pending.set(key, job);
    return job.promise;
  }
}

const regularWorker = new RegularRiskWorker();
const regularScheduler = new RegularRiskScheduler((input) => regularWorker.compute(input));

export function evaluateRegularRiskInBackground(input: RegularRiskInput): Promise<Result> {
  return regularScheduler.evaluate(input);
}
