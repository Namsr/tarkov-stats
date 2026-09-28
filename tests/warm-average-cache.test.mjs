import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

// `waitForWeb()` probes the same path the sweep opens with, so the harness
// answers the first request per case and stalls the second: that puts the stall
// inside the sweep, where one hung request blocks every later path.
function stalledServer() {
  const seen = new Map();
  return createServer((request, response) => {
    const prefix = request.url?.startsWith("/trickle") ? "/trickle" : "/silent";
    const count = (seen.get(prefix) ?? 0) + 1;
    seen.set(prefix, count);
    if (count === 1) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    if (prefix === "/trickle") {
      response.writeHead(200, { "content-type": "application/json" });
      const trickle = setInterval(() => response.write(" "), 100);
      response.on("close", () => clearInterval(trickle));
      return;
    }
    // accepted and never answered
  });
}

// The script is a long-lived warmer (setInterval), so there is no exit code to
// assert: a wedged sweep just sits silent forever with the `running` guard
// still set, which turns the interval into a no-op. The bound is what makes the
// run fail the way a 500 already does -- logged, then retried on the next tick.
async function collectWarmupRun(prefix, port) {
  const child = spawn(process.execPath, ["scripts/warm-average-cache.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_NO_WARNINGS: "1",
      AVERAGE_WARM_BASE_URL: `http://127.0.0.1:${port}${prefix}`,
      // The seam exists so this case costs a second instead of the production
      // 30s; the script still keeps 30_000 as its default.
      AVERAGE_WARM_TIMEOUT_MS: "1000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let report;
  const reported = new Promise((resolve) => { report = resolve; });
  const collect = (chunk) => {
    output += chunk;
    if (/average cache warm (failed|completed)/.test(output)) report();
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  // The deadline is only a backstop, and unref'd, so a regression reports a
  // failed assertion instead of holding the runner open for its full duration.
  let cancelBackstop;
  const backstop = new Promise((resolve) => {
    const timer = setTimeout(resolve, 30_000);
    timer.unref();
    cancelBackstop = () => clearTimeout(timer);
  });
  try {
    await Promise.race([reported, once(child, "exit"), backstop]);
    return output;
  } finally {
    cancelBackstop();
    child.kill("SIGKILL");
  }
}

test("a stalled average warmup response is bounded instead of wedging the sweep", async (t) => {
  const server = stalledServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  for (const name of ["silent", "trickle"]) {
    const output = await collectWarmupRun(`/${name}`, port);
    assert.match(output, /average cache warm failed \(startup\)/, `${name}: the warm run must fail, not hang`);
    assert.match(output, /abort|timed out|TimeoutError/i, `${name}: the failure must name the abort`);
  }
});
