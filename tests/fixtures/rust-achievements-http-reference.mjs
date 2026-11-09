// Invoke the unchanged exported TypeScript handler with real storage/cache/reference files.
import "./rust-cohort-data.mjs";
import { startTsGetAdapter } from "./rust-seasonal-http.mjs";
const { GET } = await import("../../app/api/average/achievements/route.ts");
const { NextRequest } = await import("next/server");
const server = await startTsGetAdapter(GET, NextRequest);
console.log(JSON.stringify({ event: "achievements_ts_ready", address: server.base }));
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await server.stop(); process.exit(0); }
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
