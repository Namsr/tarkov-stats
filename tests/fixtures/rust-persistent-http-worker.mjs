// Fault controls are private synthetic files, never public HTTP inputs.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
const [payloadPath, controlPath, eventsPath] = process.argv.slice(2);
let last = { mode: "echo" };
function control() { try { last = JSON.parse(readFileSync(controlPath, "utf8")); } catch { /* Private file replacement may be in flight. */ } return last.mode; }
const lines = createInterface({ input: process.stdin });
lines.on("line", async line => {
  const request = JSON.parse(line), job = request.args[0];
  appendFileSync(eventsPath, JSON.stringify({ event: "started", kind: job.kind, pid: process.pid }) + "\n");
  const mode = control();
  if (mode === "crash") process.exit(17);
  if (mode === "invalid_reply") { process.stdout.write("not-json\n"); return; }
  if (mode === "hold") while (control() === "hold") await delay(10);
  if (mode === "error") { process.stdout.write(JSON.stringify({ id: request.id, error: "Synthetic calculation error" }) + "\n"); return; }
  const payloads = JSON.parse(readFileSync(payloadPath, "utf8"));
  const metric = job.kind === "persistent_metrics";
  let result = metric ? payloads.metrics : payloads.average;
  const body = metric ? result : result.body;
  body.mode = job.mode;
  body.statistic = job.args[metric ? 0 : 3]; body.period = job.args[metric ? 1 : 4];
  if (!metric) { body.dimension = job.args[0]; body.metric = job.args[1]; }
  if (mode === "wrong_identity") body.mode = job.mode === "pve" ? "regular" : "pve";
  if (mode === "bad_body") { if (metric) body.series.kd_ratio = [null]; else body.histogram = [null]; }
  if (mode === "primitive_result") result = 7;
  if (mode === "unavailable") {
    if (metric) result = null;
    else result = { storage: "unavailable", body: { ...body, total: 0, averages: null, metricCounts: {}, brackets: [], buckets: [], histogram: [], bounds: { min: 0, max: body.dimension === "hours" ? 5000 : 1000 } } };
  }
  appendFileSync(eventsPath, JSON.stringify({ event: "finished", kind: job.kind, pid: process.pid }) + "\n");
  process.stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
});
lines.on("close", () => process.exit(0));
