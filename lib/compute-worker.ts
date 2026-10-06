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
};
type Reply<Result> = { id: number } & ({ result: Result } | { error: string });

export class ComputeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComputeUnavailableError";
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
    if (this.jobs.length >= (this.options.maxPending ?? 16)) {
      return Promise.reject(this.unavailable(`${this.options.name} queue is full`));
    }
    return new Promise((resolve, reject) => {
      const job: Job<Args, Result> = { id: ++this.nextId, args, resolve, reject };
      if (this.options.totalTimeoutMs !== undefined) {
        job.deadline = setTimeout(() => {
          const error = this.unavailable(`${this.options.name} request timed out`);
          if (this.jobs[0] === job) this.fail(error);
          else {
            const index = this.jobs.indexOf(job);
            if (index !== -1) this.jobs.splice(index, 1);
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

  private unavailable(message: string): Error {
    return this.options.unavailableError?.(message) ?? new ComputeUnavailableError(message);
  }

  private fail(error: Error): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const child = this.child;
    this.child = undefined;
    child?.kill("SIGKILL");
    for (const job of this.jobs.splice(0)) {
      if (job.deadline) clearTimeout(job.deadline);
      job.reject(error);
    }
  }

  private dispatch(): void {
    if (this.timer || this.jobs.length === 0) return;
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
            this.fail(this.unavailable(`${this.options.name} worker exited (${signal ?? code})`));
          }
        });
      }
      const child = this.child;
      child.ref();
      child.channel?.ref();
      // Bound synchronous work in the child, including time spent waiting for SQLite.
      this.timer = setTimeout(() => {
        this.fail(this.unavailable(`${this.options.name} worker timed out`));
      }, this.options.timeoutMs ?? 60_000);
      this.timer.unref();
      const { id, args } = this.jobs[0];
      child.send({ id, args }, (error) => {
        if (error && this.child === child) this.fail(this.unavailable(error.message));
      });
    } catch (error) {
      this.fail(this.unavailable(error instanceof Error ? error.message : String(error)));
    }
  }
}
