import { computeCohort } from "../lib/cohort-compute.ts";

process.on("message", async ({ id, args: [job] }) => {
  try {
    const result = await computeCohort(job);
    if (process.connected) process.send({ id, result });
  } catch (error) {
    if (process.connected) process.send({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
process.on("disconnect", () => process.exit(0));
