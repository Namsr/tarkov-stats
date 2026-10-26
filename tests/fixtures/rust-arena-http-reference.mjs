// Genuine TS GET reference in an independent process: module-scoped rate
// limiter/trusted-header configuration and all durable handles match runtime.
import "./rust-cohort-data.mjs";
import { startTsGetAdapter } from "./rust-seasonal-http.mjs";
const { GET } = await import("../../app/api/average/route.ts");
const { NextRequest } = await import("next/server");
const { stopCohortWorkersForTests } = await import("../../lib/cohort-worker.ts");
const server = await startTsGetAdapter(GET, NextRequest);
console.log(JSON.stringify({ event: "arena_ts_ready", address: server.base }));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  stopCohortWorkersForTests();
  await server.stop();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
