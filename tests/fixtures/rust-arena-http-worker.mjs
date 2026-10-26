// Private-file fault controls, never HTTP headers or production endpoints.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
const [resultPath, controlPath, eventsPath] = process.argv.slice(2);
let last = { mode: "echo" };
function control() { try { last = JSON.parse(readFileSync(controlPath, "utf8")); } catch { /* Atomic update may be in flight. */ } return last; }
const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  const request = JSON.parse(line);
  const job = request.args[0];
  const input = job.args[0];
  appendFileSync(eventsPath, `${JSON.stringify({ event: "started", kind: job.kind, input, pid: process.pid })}\n`);
  const mode = control().mode;
  if (mode === "crash") process.exit(17);
  if (mode === "invalid_reply") { process.stdout.write("not-json\n"); return; }
  if (mode === "hold") while (control().mode === "hold") await delay(10);
  if (mode === "error" || mode === "busy") {
    process.stdout.write(`${JSON.stringify({ id: request.id, error: mode === "busy" ? "database is locked" : "synthetic worker error" })}\n`);
    return;
  }
  let result = JSON.parse(readFileSync(resultPath, "utf8"));
  result.filterIdentity = { mode: input.mode, statistic: input.statistic ?? "trimmed_mean", dimension: input.dimension ?? "matches",
    metric: input.metric ?? "players", minHours: input.minHours ?? null, maxHours: input.maxHours ?? null,
    minMatches: input.minMatches ?? null, maxMatches: input.maxMatches ?? null };
  if (mode === "primitive_result") result = 7;
  if (mode === "wrong_identity") result.filterIdentity.mode = "teamFight";
  if (mode === "wrong_filter") result.filterIdentity.minHours = 17;
  if (mode === "wrong_kind") result = { available: true, result: { mode: "seasonal", aid: 1, cycleId: "wrong" } };
  if (mode === "null_result") result = null;
  appendFileSync(eventsPath, `${JSON.stringify({ event: "finished", kind: job.kind, input, pid: process.pid })}\n`);
  process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
});
lines.on("close", () => process.exit(0));
