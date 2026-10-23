import { captureHomeBanCounter, HOME_BAN_SAMPLE_MS } from "../lib/home-ban-sampler.ts";

let running = false;
async function sample() {
  if (running) return;
  running = true;
  try { await captureHomeBanCounter(); }
  catch (error) {
    console.warn("home ban sampler: " + error.message);
    if (process.argv.includes("--once")) process.exitCode = 1;
  } finally { running = false; }
}
await sample();
if (!process.argv.includes("--once")) {
  const timer = setInterval(() => void sample(), HOME_BAN_SAMPLE_MS);
  const stop = () => clearInterval(timer);
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
