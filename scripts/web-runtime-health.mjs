import { startRuntimeHealth } from "../lib/observability/runtime-health.mjs";

if (process.env.RUNTIME_HEALTH_ENABLED !== "false") startRuntimeHealth();
