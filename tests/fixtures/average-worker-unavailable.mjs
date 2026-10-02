import { AverageComputeUnavailableError } from "../../lib/average-worker.ts";

export { AverageComputeUnavailableError };
export function computeAverageInBackground() {
  throw new AverageComputeUnavailableError("Average compute queue is full");
}
