import { spawn } from "node:child_process";

const childEnvironment = { ...process.env };
const warmEnvironment = {
  ...childEnvironment,
  AVERAGE_WARM_BASE_URL: process.env.AVERAGE_WARM_BASE_URL || "http://127.0.0.1:3000",
};
let stopping = false;

const server = spawn(process.execPath, ["--experimental-sqlite", "server.js"], {
  env: childEnvironment,
  stdio: "inherit",
});
const warmer = spawn(process.execPath, ["scripts/warm-average-cache.mjs"], {
  env: warmEnvironment,
  stdio: "inherit",
});
const progressionMaterializer = spawn(process.execPath, [
  "--experimental-strip-types",
  "--experimental-sqlite",
  "scripts/materialize-progression-population.mjs",
], {
  env: childEnvironment,
  stdio: "inherit",
});
const seasonalFeedSync = spawn(process.execPath, ["scripts/sync-seasonal-feed-loop.mjs"], {
  env: childEnvironment,
  stdio: "inherit",
});

function stop(signal) {
  if (stopping) return;
  stopping = true;
  server.kill(signal);
  warmer.kill(signal);
  progressionMaterializer.kill(signal);
  seasonalFeedSync.kill(signal);
}

process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

server.once("exit", (code, signal) => {
  if (!stopping) warmer.kill("SIGTERM");
  if (!stopping) progressionMaterializer.kill("SIGTERM");
  if (!stopping) seasonalFeedSync.kill("SIGTERM");
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
