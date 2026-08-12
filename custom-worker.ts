/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-ignore OpenNext generates this module before Wrangler bundles the custom entrypoint.
import handler from "./.open-next/worker.js";
import { materializeScheduledD1Population, type ProgressionSchedulerEnv } from "./lib/seasonal/population-scheduler";

type ScheduledEvent = { scheduledTime: number };
type WaitUntilContext = { waitUntil(promise: Promise<unknown>): void };

const worker = {
  fetch: handler.fetch,
  scheduled(event: ScheduledEvent, env: ProgressionSchedulerEnv, ctx: WaitUntilContext) {
    ctx.waitUntil(materializeScheduledD1Population(env, event.scheduledTime).then((result) => {
      if (result.skipped) console.warn("scheduled D1 progression population materialization skipped");
    }).catch((error: unknown) => {
      console.error("scheduled D1 progression population materialization failed", error);
    }));
  },
};

export default worker;

// @ts-ignore OpenNext generates these exports before Wrangler bundles the custom entrypoint.
export { DOQueueHandler, DOShardedTagCache } from "./.open-next/worker.js";
