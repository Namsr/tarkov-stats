// Invoke only the actual TypeScript GET exports, in an isolated process.
import "./rust-cohort-data.mjs";
import { startTsGetAdapter } from "./rust-seasonal-http.mjs";
import assert from "node:assert/strict";

globalThis.fetch = async input => { console.error(`unexpected-upstream-fetch:${String(input)}`); throw new Error("fixture forbids outbound fetch"); };
const { getAchievements } = await import("../../lib/tarkov-api.ts");
const metadata = await getAchievements("seasonal");
assert.equal(metadata.size, 3, "the actual TS parser must accept the fresh fixture without upstream fetch");
assert.equal(metadata.get("zero")?.nameRu, "Ноль");
const routes = new Map([
  ["/api/seasonal/average", (await import("../../app/api/seasonal/average/route.ts")).GET],
  ["/api/average/metrics", (await import("../../app/api/average/metrics/route.ts")).GET],
  ["/api/progression/average", (await import("../../app/api/progression/average/route.ts")).GET],
  ["/api/average/achievements", (await import("../../app/api/average/achievements/route.ts")).GET],
]);
const { NextRequest } = await import("next/server");
const { stopCohortWorkersForTests } = await import("../../lib/cohort-worker.ts");
const server = await startTsGetAdapter(request => routes.get(new URL(request.url).pathname)(request), NextRequest);
console.log(JSON.stringify({ event: "seasonal_population_ts_ready", address: server.base }));
let stopping = false;
async function stop() { if (stopping) return; stopping = true; stopCohortWorkersForTests(); await server.stop(); process.exit(0); }
process.stdin.once("data", stop);
process.on("SIGTERM", stop); process.on("SIGINT", stop);
