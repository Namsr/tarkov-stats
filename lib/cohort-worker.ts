import { resolve } from "node:path";
import { ComputeWorker } from "./compute-worker.ts";
import { ComputeUnavailableError } from "./compute-worker.ts";
import { DynamicComputeTimeoutError } from "./average-dynamic-cache.ts";
import type { CohortJob, CohortResults } from "@/lib/cohort-compute";

export class CohortComputeWorker extends ComputeWorker<[CohortJob], CohortResults[keyof CohortResults]> {
  constructor(options: { executableForArgs?: (args: [CohortJob]) => string | undefined; executable?: string; entry?: string; timeoutMs?: number; maxPending?: number; totalTimeoutMs?: number } = {}) {
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

/** Only Regular comparisons opt in; the remaining jobs keep their existing worker. */
export function regularCohortBackend(job: CohortJob, backend = process.env.REGULAR_COHORT_BACKEND): "rust" | "typescript" {
  return backend === "rust" && job.kind === "persistent" && job.mode === "regular" ? "rust" : "typescript";
}

const worker = new CohortComputeWorker({
  executableForArgs: ([job]) => regularCohortBackend(job) === "rust"
    ? process.env.RUST_COHORT_BIN || resolve("rust/cohort-worker/target/release", `tarkov-cohort-worker${process.platform === "win32" ? ".exe" : ""}`)
    : undefined,
});

/** Release child handles between isolated fixtures and benchmark series. */
export function stopCohortWorkersForTests(): void {
  worker.stop();
}

export function computeCohortInBackground<Job extends CohortJob>(job: Job,
  observe?: (timing: { queueMs: number; workerMs?: number }) => void,
): Promise<CohortResults[Job["kind"]]> {
  // One bounded diagnostic per actual worker job, with no account IDs, filters
  // or payloads. This identifies the head-of-line calculation before changing
  // queue policy; cache hits do not produce jobs or extra events.
  const startedAt = Date.now();
  let phases: { queueMs: number; workerMs?: number } | undefined;
  const report = (outcome: string) => {
    try {
      console.info(JSON.stringify({ event: "cohort_job_v1", at: Date.now(), kind: job.kind,
        outcome, backend: regularCohortBackend(job), elapsed_ms: Date.now() - startedAt,
        ...(phases ? { queue_ms: phases.queueMs, worker_ms: phases.workerMs } : {}),
      }));
    } catch { /* Diagnostics must not change the compute result. */ }
  };
  return worker.computeObserved([job], (timing) => { phases = timing; observe?.(timing); }).then(
    (value) => { report("success"); return value; },
    (error: unknown) => {
      report(error instanceof ComputeUnavailableError ? error.reason : "calculation_error");
      throw error;
    },
  ) as Promise<CohortResults[Job["kind"]]>;
}

export function cohortFailureDiagnostic(error: unknown) {
  const reason = error instanceof DynamicComputeTimeoutError ? "response_timeout"
    : error instanceof ComputeUnavailableError ? error.reason : "calculation_error";
  return { failureStage: reason === "calculation_error" ? "application" as const : "dependency" as const,
    errorCode: `average_cohort_${reason}` };
}
