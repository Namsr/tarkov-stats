import { spawn } from "node:child_process";
import { setPriority } from "node:os";

const childEnvironment = { ...process.env };
let stopping = false;

const server = spawn(process.execPath, ["--experimental-sqlite", "server.js"], {
  env: childEnvironment,
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
const averageMaterializer = spawn(process.execPath, [
  "--experimental-strip-types",
  "--experimental-sqlite",
  "--experimental-loader",
  "./scripts/ts-alias-loader.mjs",
  "scripts/materialize-average-publications.mjs",
], {
  env: childEnvironment,
  stdio: "inherit",
});
if (progressionMaterializer.pid) {
  try {
    setPriority(progressionMaterializer.pid, 19);
  } catch (error) {
    console.warn(`failed to lower progression materializer priority: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (averageMaterializer.pid) {
  try {
    setPriority(averageMaterializer.pid, 19);
  } catch (error) {
    console.warn(`failed to lower average materializer priority: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  server.kill(signal);
  progressionMaterializer.kill(signal);
  averageMaterializer.kill(signal);
}

process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

server.once("exit", (code, signal) => {
  if (!stopping) {
    progressionMaterializer.kill("SIGTERM");
    averageMaterializer.kill("SIGTERM");
  }
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
