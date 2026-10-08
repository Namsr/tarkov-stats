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
      // HTTP stops waiting after 25 s by default. Keep a bounded 5 s grace period for
      // late results to warm the cache; FIFO wait still counts toward 30 s.
      totalTimeoutMs: 30_000,
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
