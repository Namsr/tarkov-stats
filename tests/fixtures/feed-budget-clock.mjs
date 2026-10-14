import { appendFileSync } from "node:fs";

// Keep child startup outside the simulated 700 ms feed budget. A missing
// retry clamp records its wait and advances time so the collector still exits.
let now = Number(process.env.PROFILE_QUEUE_DEADLINE_MS) - 700;
Date.now = () => now;
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, ms, ...args) => {
  if (ms >= 1000) {
    appendFileSync(process.env.PROFILE_TEST_WAIT_LOG, String(ms) + "\n");
    now += ms;
    return realSetTimeout(callback, 0, ...args);
  }
  return realSetTimeout(callback, ms, ...args);
};
globalThis.fetch = async () => {
  appendFileSync(process.env.PROFILE_TEST_FEED_LOG, "feed\n");
  return new Response("stuck", { status: 503 });
};
