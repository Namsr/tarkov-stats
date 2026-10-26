// Deliberately controllable JSONL worker for process-supervision tests only.
// The HTTP API receives ordinary requests; controls stay in private fixture files.
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const [resultFile, controlFile, eventsFile] = process.argv.slice(2);
let lastControl = { mode: "echo" };
function control() {
  try { lastControl = JSON.parse(readFileSync(controlFile, "utf8")); } catch { /* Retain last complete control during a file update. */ }
  return lastControl;
}
const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  const request = JSON.parse(line);
  const input = request.args[0].args[0];
  appendFileSync(eventsFile, `${JSON.stringify({ event: "started", aid: input.aid, pid: process.pid })}\n`);
  const mode = control().mode;
  if (mode === "crash") process.exit(17);
  if (mode === "invalid_reply") { process.stdout.write("not-json\n"); return; }
  if (mode === "hold") while (control().mode === "hold") await delay(10);
  const result = JSON.parse(readFileSync(resultFile, "utf8"));
  result.result.aid = input.aid;
  result.result.cycleId = input.cycleId;
  result.result.identity = { aid: input.aid, mode: "seasonal", cycleId: input.cycleId };
  result.result.dimension = input.dimension ?? "hours";
  if (result.result.dimension === "pmc_raids") {
    result.result.center = result.result.axes.pmcRaids.center;
    result.result.bounds = result.result.axes.pmcRaids.bounds;
  }
  if (mode === "primitive_result") result.result = 7;
  if (mode === "wrong_identity") result.result.identity.aid = input.aid + 1;
  if (mode === "invalid_available") result.available = "true";
  appendFileSync(eventsFile, `${JSON.stringify({ event: "finished", aid: input.aid, pid: process.pid })}\n`);
  process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
});
lines.on("close", () => process.exit(0));
