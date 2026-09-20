import { spawn } from "node:child_process";
import { superviseWorker } from "./supervise-worker.mjs";

let stopping = false;
const server = spawn(process.execPath, ["--experimental-sqlite", "server.js"], {
  env: process.env, stdio: "inherit",
});
const progressionMaterializer = superviseWorker("progression", [
  "--experimental-strip-types", "--experimental-sqlite", "scripts/materialize-progression-population.mjs",
], { restartDelayMs: 15 * 60_000, restartEnv: { PROGRESSION_MATERIALIZE_INITIAL_DELAY_MS: "0" } });
const averageMaterializer = superviseWorker("average", [
  "--experimental-strip-types", "--experimental-sqlite", "--experimental-loader",
  "./scripts/ts-alias-loader.mjs", "scripts/materialize-average-publications.mjs",
]);
function stop(signal) {
  if (stopping) return;
  stopping = true;
  progressionMaterializer.stop(signal);
  averageMaterializer.stop(signal);
  server.kill(signal);
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
server.once("error", (error) => {
  console.error(`web spawn failed: ${error.message}`);
  stop("SIGTERM");
  process.exitCode = 1;
});
server.once("exit", (code, signal) => {
  stop("SIGTERM");
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
