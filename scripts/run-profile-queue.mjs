#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { delay, envInteger, log } from "./regular-profile-sync-core.mjs";

export const PROFILE_QUEUE_MODES = [
  { name: "arena", script: "sync-arena-profiles.mjs", budget: "ARENA_PROFILE_SYNC_MAX_RUN_MS", env: { ARENA_PROFILE_SYNC_RPS: "2", ARENA_PROFILE_SYNC_CONCURRENCY: "2" } },
  { name: "regular", script: "sync-regular-profiles.mjs", budget: "REGULAR_PROFILE_SYNC_MAX_RUN_MS", env: { REGULAR_PROFILE_SYNC_RPS: "1" } },
  { name: "pve", script: "sync-pve-profiles.mjs", budget: "PVE_PROFILE_SYNC_MAX_RUN_MS", env: { PVE_PROFILE_SYNC_RPS: "1" } },
  { name: "seasonal", script: "sync-seasonal-profiles.mjs", budget: "SEASONAL_FEED_MAX_RUN_MS", env: { SEASONAL_FEED_RPS: "1" } },
];
export const PROFILE_QUEUE_MAX_RUN_MS = 60 * 60_000;
export const PROFILE_QUEUE_SLICE_MS = 5 * 60_000;

export function summaryComplete(result) {
  const summary = result.summary;
  return result.code === 0 && !result.killed && summary != null && [200, 304].includes(summary.feedHttpStatus)
    && !summary.feedError && summary.errors === 0 && Number.isInteger(summary.backlog) && summary.backlog === 0;
}

/** Stream diagnostics, but use the structured collector result rather than exit 0 alone. */
export function runCollector(mode, budgetMs, deadline, signal) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--experimental-sqlite", `scripts/${mode.script}`], {
      env: { ...process.env, ...mode.env, [mode.budget]: String(Math.max(60_000, budgetMs)),
        PROFILE_QUEUE_DEADLINE_MS: String(Math.min(deadline, Date.now() + budgetMs)) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let summary = null;
    let tail = "";
    let killed = false;
    let killTimer;
    const decoder = new StringDecoder("utf8");
    const stop = () => {
      if (killed) return;
      killed = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), Math.max(1, Math.min(5000, deadline - Date.now())));
    };
    const watchdog = setTimeout(stop, Math.max(1, Math.min(budgetMs, deadline - Date.now() - 5000)));
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    child.stdout.pipe(process.stdout, { end: false });
    child.stderr.pipe(process.stderr, { end: false });
    child.stdout.on("data", (chunk) => {
      tail += decoder.write(chunk);
      const lines = tail.split("\n");
      tail = lines.pop();
      if (tail.length > 256_000) tail = "";
      for (const line of lines) {
        const match = mode.name === "warmup" ? /^(\{.*\})\r?$/.exec(line) : / SUMMARY (\{.*\})\r?$/.exec(line);
        if (!match) continue;
        try { summary = JSON.parse(match[1]); } catch { summary = null; }
      }
    });
    child.on("error", (error) => log("COLLECTOR_ERROR", { mode: mode.name, error: error.message }));
    child.on("close", (code) => {
      clearTimeout(watchdog);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", stop);
      resolveResult({ code: code ?? 1, summary, killed });
    });
  });
}

export async function runProfileQueue({ deadline = Date.now() + PROFILE_QUEUE_MAX_RUN_MS, sliceMs = PROFILE_QUEUE_SLICE_MS,
  run = runCollector, now = Date.now, wait = delay, emit = log, signal } = {}) {
  const states = PROFILE_QUEUE_MODES.map((mode) => ({ mode, complete: false, retryAt: 0, failures: 0, result: null }));
  let round = 0;
  // Reserve five seconds to stop an unresponsive child before the common deadline.
  const workDeadline = deadline - 5000;
  while (!signal?.aborted && now() < workDeadline && states.some((state) => !state.complete)) {
    round += 1;
    let visited = false;
    for (const state of states) {
      if (signal?.aborted || now() >= workDeadline) break;
      if (state.complete || state.retryAt > now()) continue;
      visited = true;
      const budgetMs = Math.min(sliceMs, workDeadline - now());
      emit("MODE_START", { mode: state.mode.name, round, budgetMs });
      let result;
      try {
        result = await run(state.mode, budgetMs, deadline, signal);
      } catch (error) {
        emit("COLLECTOR_ERROR", { mode: state.mode.name, error: error.message });
        result = { code: 1, summary: null };
      }
      state.result = result;
      state.complete = summaryComplete(result);
      const failed = result.code !== 0 || result.killed || !result.summary || result.summary.feedError || result.summary.errors > 0;
      state.failures = failed ? state.failures + 1 : 0;
      state.retryAt = now() + (failed ? Math.min(5 * 60_000, 60_000 * 2 ** Math.min(3, state.failures - 1)) : 0);
      // Empty attempts must not spin on SQLite in a tight loop.
      if (!state.complete && !result.summary?.attempted) state.retryAt = Math.max(state.retryAt, now() + 60_000);
      emit("MODE_RESULT", { mode: state.mode.name, round, code: result.code, complete: state.complete,
        backlog: result.summary?.backlog ?? null, errors: result.summary?.errors ?? null, retryAt: state.complete ? null : state.retryAt });
    }
    if (!visited) {
      const next = Math.min(workDeadline, ...states.filter((state) => !state.complete).map((state) => state.retryAt));
      await wait(Math.min(1000, Math.max(1, next - now())));
    }
  }
  const complete = !signal?.aborted && states.every((state) => state.complete);
  // Retain the bounded warmup, only after all four collectors finish.
  let warmupOk = true;
  if (complete && workDeadline - now() >= 60_000) {
    let warmup;
    try {
      warmup = await run({ name: "warmup", script: "warmup-leaderboard-profiles.mjs",
        budget: "LEADERBOARD_WARMUP_MAX_RUN_MS", env: { LEADERBOARD_WARMUP_MAX_PROFILES: "100" } },
      Math.min(3 * 60_000, workDeadline - now()), deadline, signal);
    } catch (error) {
      emit("COLLECTOR_ERROR", { mode: "warmup", error: error.message });
      warmup = { code: 1, summary: null };
    }
    warmupOk = warmup.code === 0 && !warmup.killed && warmup.summary?.bounded === true && warmup.summary?.stopped === false
      && Number.isInteger(warmup.summary?.processed) && warmup.summary.processed >= 0;
    emit("MODE_RESULT", { mode: "warmup", code: warmup.code });
  }
  const summary = { ok: complete && warmupOk && !signal?.aborted,
    reason: signal?.aborted ? "signal" : !complete ? "deadline" : !warmupOk ? "warmup_failed" : "complete",
    rounds: round, modes: Object.fromEntries(states.map((state) => [state.mode.name,
      { complete: state.complete, backlog: state.result?.summary?.backlog ?? null, code: state.result?.code ?? null }])) };
  emit("QUEUE_SUMMARY", summary);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  const defaultDeadline = Date.now() + PROFILE_QUEUE_MAX_RUN_MS;
  const deadline = Math.min(defaultDeadline, envInteger("PROFILE_QUEUE_DEADLINE_MS", defaultDeadline, 1, Number.MAX_SAFE_INTEGER));
  const result = await runProfileQueue({ deadline, signal: controller.signal });
  process.exitCode = result.ok ? 0 : controller.signal.aborted ? 143 : 1;
}
