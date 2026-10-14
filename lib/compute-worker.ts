import { spawn, type ChildProcess } from "node:child_process";
import { setPriority } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type ComputeWorkerOptions = {
  name: string;
  entry: string;
  timeoutMs?: number;
  maxPending?: number;
  /** Optional end-to-end budget, including time waiting in the FIFO. */
  totalTimeoutMs?: number;
  unavailableError?: (message: string) => Error;
};

type Job<Args extends unknown[], Result> = {
  id: number;
  args: Args;
  resolve: (result: Result) => void;
  reject: (error: Error) => void;
  deadline?: ReturnType<typeof setTimeout>;
  queuedAt: number;
  dispatchedAt?: number;
  observe?: (timing: { queueMs: number; workerMs?: number }) => void;
};
type Reply<Result> = { id: number } & ({ result: Result } | { error: string });

export class ComputeUnavailableError extends Error {
  readonly reason: string;
  constructor(message: string, reason = "unavailable") {
    super(message);
    this.name = "ComputeUnavailableError";
    this.reason = reason;
  }
}

// One process and a bounded FIFO keep cold, distinct ranges from spawning a
// process per request or competing with HTTP for every available CPU.
export class ComputeWorker<Args extends unknown[], Result> {
  private child?: ChildProcess;
  private timer?: ReturnType<typeof setTimeout>;
  private jobs: Job<Args, Result>[] = [];
  private nextId = 0;
  private readonly options: ComputeWorkerOptions;

  constructor(options: ComputeWorkerOptions) {
    this.options = options;
  }

  compute(...args: Args): Promise<Result> {
    return this.computeObserved(args);
  }

  computeObserved(args: Args, observe?: Job<Args, Result>["observe"]): Promise<Result> {
    if (this.jobs.length >= (this.options.maxPending ?? 16)) {
      return Promise.reject(this.unavailable(`${this.options.name} queue is full`, "queue_full"));
    }
    return new Promise((resolve, reject) => {
      const job: Job<Args, Result> = { id: ++this.nextId, args, resolve, reject, queuedAt: performance.now(), observe };
      if (this.options.totalTimeoutMs !== undefined) {
        job.deadline = setTimeout(() => {
          const error = this.unavailable(`${this.options.name} request timed out`, "deadline");
          if (this.jobs[0] === job) this.fail(error, true);
          else {
            const index = this.jobs.indexOf(job);
            if (index !== -1) this.jobs.splice(index, 1);
            this.measure(job);
            job.reject(error);
          }
        }, this.options.totalTimeoutMs);
        job.deadline.unref();
      }
      this.jobs.push(job);
      this.dispatch();
    });
  }

  stop(): void {
    this.fail(this.unavailable(`${this.options.name} worker stopped`));
  }

  private unavailable(message: string, reason = "unavailable"): Error {
    return this.options.unavailableError?.(message) ?? new ComputeUnavailableError(message, reason);
  }

  private measure(job: Job<Args, Result>, completed = true): void {
    const now = performance.now();
    try {
      job.observe?.({ queueMs: Math.round((job.dispatchedAt ?? now) - job.queuedAt),
        ...(!completed || job.dispatchedAt === undefined ? {} : { workerMs: Math.round(now - job.dispatchedAt) }) });
    } catch { /* Diagnostics must not interfere with job completion. */ }
  }

  private fail(error: Error, preserveQueued = false): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const child = this.child;
    this.child = undefined;
    child?.kill("SIGKILL");
    for (const job of this.jobs.splice(0, preserveQueued ? 1 : this.jobs.length)) {
      if (job.deadline) clearTimeout(job.deadline);
      this.measure(job);
      job.reject(error);
    }
    // A timeout belongs to the active job. Younger queued requests still have
    // their own budget and must run on a fresh child instead of inheriting it.
    if (preserveQueued) this.dispatch();
  }

  private dispatch(): void {
    if (this.timer) return;
    // Do not restart work whose original end-to-end budget already expired.
    while (this.jobs.length && this.options.totalTimeoutMs !== undefined &&
        performance.now() - this.jobs[0].queuedAt >= this.options.totalTimeoutMs) {
      const expired = this.jobs.shift()!;
      if (expired.deadline) clearTimeout(expired.deadline);
      this.measure(expired);
      expired.reject(this.unavailable(`${this.options.name} request timed out`, "deadline"));
    }
    if (this.jobs.length === 0) return;
    try {
      if (!this.child) {
        const child = spawn(process.execPath, [
          "--experimental-strip-types", "--experimental-sqlite", "--experimental-loader",
          pathToFileURL(resolve("scripts/ts-alias-loader.mjs")).href,
          resolve(this.options.entry),
        ], {
          serialization: "advanced",
          stdio: ["ignore", "inherit", "inherit", "ipc"],
          windowsHide: true,
        });
        this.child = child;
        if (child.pid) {
          try { setPriority(child.pid, 19); }
          catch (error) { console.warn(`${this.options.name} worker: failed to lower priority`, error); }
        }
        child.on("message", (message: Reply<Result>) => {
          if (this.child !== child || message.id !== this.jobs[0]?.id) return;
          if (this.timer) clearTimeout(this.timer);
          this.timer = undefined;
          const job = this.jobs.shift()!;
          if (job.deadline) clearTimeout(job.deadline);
          this.measure(job);
          if ("error" in message) job.reject(new Error(message.error));
          else job.resolve(message.result);
          if (this.jobs.length) this.dispatch();
          else {
            // Idle IPC must not keep CLI tools/tests alive. The child exits on
            // disconnect when its parent shuts down.
            child.unref();
            child.channel?.unref();
          }
        });
        child.once("error", (error) => {
          if (this.child === child) this.fail(this.unavailable(error.message));
        });
        child.once("exit", (code, signal) => {
          if (this.child === child) {
            this.fail(this.unavailable(`${this.options.name} worker exited (${signal ?? code})`, "worker_exit"));
          }
        });
      }
      const child = this.child;
      child.ref();
      child.channel?.ref();
      // Bound synchronous work in the child, including time spent waiting for SQLite.
      this.timer = setTimeout(() => {
        this.fail(this.unavailable(`${this.options.name} worker timed out`, "worker_timeout"), true);
      }, this.options.timeoutMs ?? 60_000);
      this.timer.unref();
      const { id, args } = this.jobs[0];
      this.jobs[0].dispatchedAt = performance.now();
      this.measure(this.jobs[0], false);
      child.send({ id, args }, (error) => {
        if (error && this.child === child) this.fail(this.unavailable(error.message));
      });
    } catch (error) {
      this.fail(this.unavailable(error instanceof Error ? error.message : String(error)));
    }
  }
}
