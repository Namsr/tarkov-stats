import { ComputeWorker } from "./compute-worker.ts";
import type { CohortJob, CohortResults } from "@/lib/cohort-compute";

export class CohortComputeWorker extends ComputeWorker<[CohortJob], CohortResults[keyof CohortResults]> {
  constructor(options: { entry?: string; timeoutMs?: number; maxPending?: number; totalTimeoutMs?: number } = {}) {
    super({
      name: "Comparison cohort",
      entry: "scripts/compute-cohort-worker.mjs",
      timeoutMs: 15_000,
      totalTimeoutMs: 15_000,
      maxPending: 8,
      ...options,
    });
  }
}

const worker = new CohortComputeWorker();

export function computeCohortInBackground<Job extends CohortJob>(job: Job): Promise<CohortResults[Job["kind"]]> {
  // Each kind is dispatched to exactly one existing calculation in the child.
  return worker.compute(job) as Promise<CohortResults[Job["kind"]]>;
}
