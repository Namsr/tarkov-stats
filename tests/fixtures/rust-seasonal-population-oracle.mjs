// Test-only IPC entry; all SQL/math remain in the unmodified real TS implementation.
import "./rust-cohort-data.mjs";
const { computeSeasonalAverageCrossSection, computeSeasonalMetricSeries } = await import("../../lib/seasonal/average-db.ts");
process.on("message", async ({ id, args: [job] }) => {
  try {
    const input = job.args[0];
    const result = job.kind === "seasonal_average" ? await computeSeasonalAverageCrossSection(input)
      : await computeSeasonalMetricSeries(input.cycleId, input.period, input.statistic, input.now);
    if (process.connected) process.send({ id, result });
  } catch (error) { if (process.connected) process.send({ id, error: error.message }); }
});
process.on("disconnect", () => process.exit(0));
