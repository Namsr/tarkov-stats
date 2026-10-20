import { existsSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(":memory:");
const sql = db.prepare("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<3000) SELECT SUM(x) FROM n");
process.on("message", ({ id, args: [job] }) => {
  if (job.domain === "crash") process.exit(17);
  if (job.domain === "stall") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
  if (job.domain === "hold") {
    const marker = process.env.ADMIN_REPORT_TEST_MARKER;
    writeFileSync(marker, "busy");
    const deadline = Date.now() + 20000;
    while (!existsSync(`${marker}.release`) && Date.now() < deadline) sql.get();
  }
  process.send(job.domain === "error" ? { id, error: "private fixture error" } : { id, result: { pid: process.pid } });
});
process.on("disconnect", () => process.exit(0));
