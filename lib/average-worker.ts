import { spawn, type ChildProcess } from "node:child_process";
import { setPriority } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { computeAverage } from "@/lib/average-compute";

type Arguments = Parameters<typeof computeAverage>;
type Result = Awaited<ReturnType<typeof computeAverage>>;
type Job = {
  id: number;
  args: Arguments;
  resolve: (result: Result) => void;
  reject: (error: Error) => void;
};
type Reply = { id: number } & ({ result: Result } | { error: string });

export class AverageComputeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AverageComputeUnavailableError";
  }
}

// One process and a bounded FIFO keep cold, distinct ranges from spawning a
// process per request or competing with HTTP for every available CPU.
export class AverageComputeWorker {
  private child?: ChildProcess;
  private timer?: ReturnType<typeof setTimeout>;
  private jobs: Job[] = [];
  private nextId = 0;
  private readonly options: { entry?: string; timeoutMs?: number; maxPending?: number };

  constructor(options: {
    entry?: string;
    timeoutMs?: number;
    maxPending?: number;
  } = {}) {
    this.options = options;
  }

  compute(...args: Arguments): Promise<Result> {
    if (this.jobs.length >= (this.options.maxPending ?? 16)) {
      return Promise.reject(new AverageComputeUnavailableError("Average compute queue is full"));
    }
    return new Promise((resolve, reject) => {
      this.jobs.push({ id: ++this.nextId, args, resolve, reject });
      this.dispatch();
    });
  }

  stop(): void {
    this.fail(new AverageComputeUnavailableError("Average compute worker stopped"));
  }

  private fail(error: Error): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const child = this.child;
    this.child = undefined;
    child?.kill("SIGKILL");
    for (const job of this.jobs.splice(0)) job.reject(error);
  }

  private dispatch(): void {
    if (this.timer || this.jobs.length === 0) return;
    try {
      if (!this.child) {
        const child = spawn(process.execPath, [
          "--experimental-strip-types", "--experimental-sqlite", "--experimental-loader",
          pathToFileURL(resolve("scripts/ts-alias-loader.mjs")).href,
          this.options.entry ?? resolve("scripts/compute-average-worker.mjs"),
        ], {
          serialization: "advanced",
          stdio: ["ignore", "inherit", "inherit", "ipc"],
          windowsHide: true,
        });
        this.child = child;
        if (child.pid) {
          try { setPriority(child.pid, 19); }
          catch (error) { console.warn("Average compute worker: failed to lower priority", error); }
        }
        child.on("message", (message: Reply) => {
          if (this.child !== child || message.id !== this.jobs[0]?.id) return;
          if (this.timer) clearTimeout(this.timer);
          this.timer = undefined;
          const job = this.jobs.shift()!;
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
          if (this.child === child) this.fail(new AverageComputeUnavailableError(error.message));
        });
        child.once("exit", (code, signal) => {
          if (this.child === child) {
            this.fail(new AverageComputeUnavailableError(`Average compute worker exited (${signal ?? code})`));
          }
        });
      }
      const child = this.child;
      child.ref();
      child.channel?.ref();
      // Longer than the HTTP caller's 25s budget: late success still warms the
      // existing dynamic cache, but a stuck SQLite query cannot hold the FIFO forever.
      this.timer = setTimeout(() => {
        this.fail(new AverageComputeUnavailableError("Average compute worker timed out"));
      }, this.options.timeoutMs ?? 60_000);
      this.timer.unref();
      const { id, args } = this.jobs[0];
      child.send({ id, args }, (error) => {
        if (error && this.child === child) this.fail(new AverageComputeUnavailableError(error.message));
      });
    } catch (error) {
      this.fail(new AverageComputeUnavailableError(error instanceof Error ? error.message : String(error)));
    }
  }
}

const worker = new AverageComputeWorker();

export function computeAverageInBackground(...args: Arguments): Promise<Result> {
  return worker.compute(...args);
}
