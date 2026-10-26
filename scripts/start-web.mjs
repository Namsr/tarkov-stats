import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { superviseWorker } from "./supervise-worker.mjs";

const selectors = ["SEASONAL_API_UPSTREAM", "HOME_SHOWCASE_API_UPSTREAM", "ARENA_UI_UPSTREAM"].map((name) => {
  const value = process.env[name] || "web:3000";
  if (!["web:3000", "web:3001"].includes(value)) {
    throw new Error(`${name} must be web:3000 or web:3001`);
  }
  return value;
});
const critical = new Set();
let stopping = false;
let progressionMaterializer;
let averageMaterializer;
let axisLeagueSync;

function stop(signal = "SIGTERM", code = 0, exitSignal) {
  if (stopping) return;
  stopping = true;
  progressionMaterializer?.stop(signal);
  averageMaterializer?.stop(signal);
  axisLeagueSync?.stop(signal);
  const running = [...critical].filter((record) => !record.closed);
  for (const { child } of running) child.kill(signal);
  const timer = setTimeout(() => {
    for (const { child, closed } of running) if (!closed) child.kill("SIGKILL");
  }, 5000);
  timer.unref();
  Promise.all(running.map((record) => record.done)).then(() => {
    clearTimeout(timer);
    if (exitSignal && process.platform !== "win32") {
      process.removeAllListeners(exitSignal);
      process.kill(process.pid, exitSignal);
    }
    else process.exit(code);
  });
}

function launchCritical(name, executable, args, options = {}) {
  const child = spawn(executable, args, { env: process.env, stdio: "inherit", windowsHide: true, ...options });
  if (child.pid) console.info(JSON.stringify({ event: "web_critical_process_v1", name, pid: child.pid }));
  let finish;
  const record = { child, closed: false, done: new Promise((resolve) => { finish = resolve; }) };
  critical.add(record);
  child.once("error", (error) => {
    console.error(`${name} spawn failed: ${error.message}`);
    stop("SIGTERM", 1);
  });
  child.once("close", (code, signal) => {
    record.closed = true;
    finish();
    if (!stopping) {
      console.error(`${name} exited: code=${code} signal=${signal}`);
      stop("SIGTERM", name === "Next.js" ? code ?? 1 : 1, name === "Next.js" ? signal : undefined);
    }
  });
  return record;
}

process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

async function startRust() {
  const executable = process.env.RUST_API_BIN || resolve("rust/backend/target/release", `tarkov-backend${process.platform === "win32" ? ".exe" : ""}`);
  const record = launchCritical("Rust API", executable, [], { stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, RUST_API_BIND: process.env.RUST_API_BIND || "0.0.0.0:3001" } });
  const address = await new Promise((resolve, reject) => {
    let partial = "";
    let ready = false;
    const timer = setTimeout(() => reject(new Error("Rust API readiness timed out")), 15000);
    record.done.then(() => { if (!ready) { clearTimeout(timer); reject(new Error("Rust API exited before readiness")); } });
    record.child.stdout.on("data", (chunk) => {
      if (!process.stdout.write(chunk)) {
        record.child.stdout.pause();
        process.stdout.once("drain", () => record.child.stdout.resume());
      }
      if (ready) return;
      partial += chunk.toString();
      if (partial.length > 65536) { clearTimeout(timer); reject(new Error("Invalid Rust API readiness output")); return; }
      const lines = partial.split("\n");
      partial = lines.pop();
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.event === "rust_api_ready" && typeof event.address === "string") {
            ready = true;
            clearTimeout(timer);
            resolve(event.address);
            return;
          }
        } catch { /* Ignore non-readiness startup diagnostics. */ }
      }
    });
  });
  const loopback = address.replace(/^0\.0\.0\.0:/, "127.0.0.1:").replace(/^\[::\]:/, "[::1]:");
  const response = await fetch(`http://${loopback}/healthz`, { signal: AbortSignal.timeout(3000) });
  await response.body?.cancel();
  if (response.status !== 200) throw new Error(`Rust API readiness returned HTTP ${response.status}`);
}

try {
  if (selectors.includes("web:3001")) await startRust();
  if (!stopping) {
    launchCritical("Next.js", process.execPath, ["--experimental-sqlite", "--import", "./scripts/web-runtime-health.mjs", "server.js"]);
    const backgroundEnabled = process.env.WEB_BACKGROUND_WORKERS !== "false";
    progressionMaterializer = backgroundEnabled ? superviseWorker("progression", [
      "--experimental-strip-types", "--experimental-sqlite", "scripts/materialize-progression-population.mjs",
    ], { restartDelayMs: 15 * 60_000, restartEnv: { PROGRESSION_MATERIALIZE_INITIAL_DELAY_MS: "0" } }) : undefined;
    averageMaterializer = backgroundEnabled ? superviseWorker("average", [
      "--experimental-strip-types", "--experimental-sqlite", "--experimental-loader",
      "./scripts/ts-alias-loader.mjs", "scripts/materialize-average-publications.mjs",
    ]) : undefined;
    axisLeagueSync = backgroundEnabled ? superviseWorker("axis-league", [
      "--experimental-strip-types", "--experimental-sqlite", "scripts/sync-axis-league.mjs",
    ]) : undefined;
  }
} catch (error) {
  console.error(`Web startup failed: ${error.message}`);
  stop("SIGTERM", 1);
}
