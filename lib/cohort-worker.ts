import { ComputeWorker } from "./compute-worker.ts";
import { ComputeUnavailableError } from "./compute-worker.ts";
import { DynamicComputeTimeoutError } from "./average-dynamic-cache.ts";
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

export function computeCohortInBackground<Job extends CohortJob>(job: Job,
  observe?: (timing: { queueMs: number; workerMs?: number }) => void,
): Promise<CohortResults[Job["kind"]]> {
  // Each kind is dispatched to exactly one existing calculation in the child.
  return (observe ? worker.computeObserved([job], observe) : worker.compute(job)) as Promise<CohortResults[Job["kind"]]>;
}

export function cohortFailureDiagnostic(error: unknown) {
  const reason = error instanceof DynamicComputeTimeoutError ? "response_timeout"
    : error instanceof ComputeUnavailableError ? error.reason : "calculation_error";
  return { failureStage: reason === "calculation_error" ? "application" as const : "dependency" as const,
    errorCode: `average_cohort_${reason}` };
}
