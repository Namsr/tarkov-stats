// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Node's strip-types runtime requires the explicit extension.
import { ComputeWorker, ComputeUnavailableError } from "./compute-worker.ts";
import type { computeAverage } from "@/lib/average-compute";

type Arguments = Parameters<typeof computeAverage>;
type Result = Awaited<ReturnType<typeof computeAverage>>;

export class AverageComputeUnavailableError extends ComputeUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = "AverageComputeUnavailableError";
  }
}

export class AverageComputeWorker extends ComputeWorker<Arguments, Result> {
  constructor(options: { entry?: string; timeoutMs?: number; maxPending?: number; totalTimeoutMs?: number } = {}) {
    super({
      // End-to-end budget, FIFO wait included: the route gives the client up
      // after the same 25 s, so a job that is still queued (or still running)
      // then serves nobody. Without it a stuck head holds its slot for the
      // whole 60 s child timeout and the FIFO behind it waits unbounded.
      // Same value as CohortComputeWorker, which ties its two deadlines too.
      totalTimeoutMs: 25_000,
      ...options,
      name: "Average compute",
      entry: options.entry ?? "scripts/compute-average-worker.mjs",
      unavailableError: (message) => new AverageComputeUnavailableError(message),
    });
  }
}

const worker = new AverageComputeWorker();

export function computeAverageInBackground(...args: Arguments): Promise<Result> {
  return worker.compute(...args);
}
