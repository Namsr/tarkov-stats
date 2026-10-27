import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

export function rustBackendBinary() {
  return process.env.RUST_BACKEND_BIN || resolve("rust/backend/target/release",
    `tarkov-backend${process.platform === "win32" ? ".exe" : ""}`);
}

export async function startRustBackend(env = {}) {
  const child = spawn(rustBackendBinary(), [], { env: { ...process.env, RUST_API_BIND: "127.0.0.1:0", ...env },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let logs = "";
  let stopped = false;
  let exited = false;
  const exit = new Promise((resolve) => {
    child.once("exit", (code, signal) => { exited = true; resolve({ code, signal }); });
    child.once("error", (error) => { exited = true; resolve({ error }); });
  });
  const collect = (chunk) => { logs = `${logs}${chunk}`.slice(-256 * 1024); };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const lines = createInterface({ input: child.stdout });
  async function stop() {
    if (stopped) return;
    stopped = true;
    lines.close();
    if (!exited) child.kill();
    const done = await Promise.race([exit.then(() => true), delay(3000, undefined, { ref: false }).then(() => false)]);
    if (!done) { child.kill("SIGKILL"); await exit; }
    child.stdout.destroy(); child.stderr.destroy();
  }
  try {
    const address = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Rust HTTP server startup timed out: ${logs}`)), 15000);
      const complete = (work) => { clearTimeout(timer); work(); };
      child.once("error", (error) => complete(() => reject(error)));
      child.once("exit", (code, signal) => complete(() => reject(new Error(`Rust HTTP server exited (${signal ?? code}): ${logs}`))));
      lines.on("line", (line) => {
        try {
          const event = JSON.parse(line);
          if (event.event === "rust_api_ready") complete(() => resolve(event.address));
        } catch { /* Other operational diagnostics do not announce readiness. */ }
      });
    });
    assert.match(address, /^127\.0\.0\.1:\d+$/);
    return { child, base: `http://${address}`, logs: () => logs, stop };
  } catch (error) { await stop(); throw error; }
}

// This adapter invokes ONLY the exported GET handler. It deliberately does not
// simulate Next's global headers or automatic HEAD/OPTIONS/405 implementation.
export async function startTsGetAdapter(get, NextRequest) {
  const server = createServer(async (request, response) => {
    if (request.method !== "GET") { response.writeHead(501); response.end("GET-only fixture adapter"); return; }
    try {
      const result = await get(new NextRequest(`http://127.0.0.1${request.url}`, { headers: request.headers }));
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { base: `http://127.0.0.1:${server.address().port}`,
    stop: () => new Promise((resolve) => server.close(resolve)) };
}

export async function getSeasonal(base, query = "", headers = {}) {
  const response = await fetch(`${base}/api/seasonal/cohort?${query}`, { headers, signal: AbortSignal.timeout(10000) });
  return { status: response.status, headers: response.headers, body: await response.json() };
}

export function readWorkerEvents(path) {
  try { return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
  catch { return []; }
}
export function setWorkerControl(path, mode) { writeFileSync(path, JSON.stringify({ mode })); }
export async function waitForCondition(condition, description, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (condition()) return; await delay(10); }
  assert.fail(description);
}
