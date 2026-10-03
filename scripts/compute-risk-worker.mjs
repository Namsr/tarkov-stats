import { evaluateAndStoreRisk } from "../lib/admin/risk-service.ts";

// Only the child opens population/risk stores. SQL, JSON parsing and sorting
// cannot block HTTP; errors leave the last stored evaluation available.
process.on("message", async ({ id, args: [input] }) => {
  try {
    if (input.mode !== "seasonal") throw new TypeError("Seasonal risk requires seasonal mode");
    const result = await evaluateAndStoreRisk(input);
    if (process.connected) process.send({ id, result });
  } catch (error) {
    if (process.connected) process.send({ id, error: error instanceof Error ? error.message : String(error) });
  }
});

process.on("disconnect", () => process.exit(0));
