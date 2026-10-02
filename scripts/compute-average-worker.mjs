import { computeAverage } from "../lib/average-compute.ts";

// The parent sends only one job at a time. DatabaseSync may block here without
// delaying the HTTP process's event loop.
process.on("message", async ({ id, args }) => {
  try {
    const result = await computeAverage(...args);
    if (process.connected) process.send({ id, result });
  } catch (error) {
    if (process.connected) process.send({ id, error: error instanceof Error ? error.message : String(error) });
  }
});

process.on("disconnect", () => process.exit(0));
