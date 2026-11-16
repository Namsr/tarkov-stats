// Real TypeScript GET handlers, independent process for module-scoped env/limiter/cache.
import "./rust-cohort-data.mjs";
import { startTsGetAdapter } from "./rust-seasonal-http.mjs";
const { GET: average } = await import("../../app/api/average/route.ts");
const { GET: metrics } = await import("../../app/api/average/metrics/route.ts");
const { NextRequest } = await import("next/server");
const { stopCohortWorkersForTests } = await import("../../lib/cohort-worker.ts");
const server = await startTsGetAdapter(request => new URL(request.url).pathname === "/api/average/metrics" ? metrics(request) : average(request), NextRequest);
console.log(JSON.stringify({ event: "persistent_ts_ready", address: server.base }));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  stopCohortWorkersForTests();
  await server.stop();
  // The unchanged AverageComputeWorker child handles IPC disconnect on exit.
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
