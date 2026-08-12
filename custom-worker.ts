/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-ignore OpenNext generates this module before Wrangler bundles the custom entrypoint.
import handler from "./.open-next/worker.js";
import { materializeScheduledD1Population, type ProgressionSchedulerEnv } from "./lib/seasonal/population-scheduler";

export default {
  fetch: handler.fetch,
  scheduled(event, env, ctx) {
    ctx.waitUntil(materializeScheduledD1Population(env as CloudflareEnv & ProgressionSchedulerEnv, event.scheduledTime).then((result) => {
      if (result.skipped) console.warn("scheduled D1 progression population materialization skipped");
    }).catch((error) => {
      console.error("scheduled D1 progression population materialization failed", error);
    }));
  },
} satisfies ExportedHandler<CloudflareEnv>;

// @ts-ignore OpenNext generates these exports before Wrangler bundles the custom entrypoint.
export { DOQueueHandler, DOShardedTagCache } from "./.open-next/worker.js";
