import { spawn } from "node:child_process";
import { setPriority } from "node:os";

export function superviseWorker(name, args, options = {}) {
  const launch = options.spawn ?? spawn;
  const schedule = options.setTimeout ?? setTimeout;
  const cancel = options.clearTimeout ?? clearTimeout;
  const now = options.now ?? Date.now;
  const priority = options.setPriority ?? setPriority;
  const log = options.log ?? console.warn;
  let child;
  let timer;
  let stopped = false;
  let failures = 0;
  let launches = 0;
  function start() {
    if (stopped) return;
    const startedAt = now();
    child = launch(process.execPath, args, {
      env: { ...process.env, ...(launches++ > 0 ? options.restartEnv : {}) }, stdio: "inherit",
    });
    if (child.pid) {
      try { priority(child.pid, 19); }
      catch (error) { log(`${name}: failed to lower priority: ${error.message}`); }
    }
    child.once("error", (error) => log(`${name}: spawn failed: ${error.message}`));
    // close also fires after spawn errors. One handler prevents double retries.
    child.once("close", (code, signal) => {
      if (stopped) return;
      if (now() - startedAt >= 5 * 60_000) failures = 0;
      const delay = options.restartDelayMs ?? Math.min(15 * 60_000, 60_000 * 2 ** Math.min(failures++, 4));
      log(`${name}: exited code=${code} signal=${signal}; retry in ${delay}ms`);
      timer = schedule(start, delay);
    });
  }
  start();
  return {
    stop(signal = "SIGTERM") {
      stopped = true;
      if (timer) cancel(timer);
      child?.kill(signal);
    },
  };
}
