import { existsSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
const sql = db.prepare("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 5000) SELECT SUM(x) FROM n");
process.on("message", ({ id, args: [job] }) => {
  const action = job.args[0];
  if (action === "crash") process.exit(17);
  if (action === "stall") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  if (action === "hold") {
    const marker = process.env.COHORT_WORKER_TEST_MARKER;
    writeFileSync(marker, "busy");
    const deadline = Date.now() + 15_000;
    while (!existsSync(`${marker}.release`) && Date.now() < deadline) sql.get();
  }
  if (action === "error") process.send({ id, error: "fixture SQL failure" });
  else process.send({ id, result: { id, pid: process.pid } });
});
process.on("disconnect", () => process.exit(0));
