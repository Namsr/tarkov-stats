import { existsSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
const sql = db.prepare("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 5000) SELECT SUM(x) FROM n");

process.on("message", ({ id, args: [input] }) => {
  const action = input.stats.nickname;
  if (action === "crash") process.exit(17);
  if (action === "stall") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  if (action === "hold") {
    const marker = process.env.RISK_WORKER_TEST_MARKER;
    writeFileSync(marker, "busy");
    const deadline = performance.now() + 15_000;
    while (!existsSync(`${marker}.release`) && performance.now() < deadline) sql.get();
  }
  if (action === "error") process.send({ id, error: "fixture SQL failure" });
  else process.send({ id, result: { pid: process.pid, input } });
});
process.on("disconnect", () => process.exit(0));
