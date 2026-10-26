import { spawn, type ChildProcess } from "node:child_process";
import { setPriority } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type ComputeWorkerOptions<Args extends unknown[] = unknown[]> = {
  name: string;
  entry: string;
  /** Optional native worker speaking version 1 JSONL over stdin/stdout. */
  executable?: string;
  executableArgs?: readonly string[];
  /** Select a transport per job while retaining one shared FIFO/deadline. */
  executableForArgs?: (args: Args) => string | undefined;
  timeoutMs?: number;
  maxPending?: number;
  /** Optional end-to-end budget, including time waiting in the FIFO. */
  totalTimeoutMs?: number;
  maxOldSpaceMb?: number;
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

// One bounded FIFO permits one active calculation across reusable transports.
// Cold ranges cannot spawn a process per request or consume every HTTP CPU.
export class ComputeWorker<Args extends unknown[], Result> {
  private child?: ChildProcess;
  private readonly children = new Map<string, ChildProcess>();
  private readonly nativeChildren = new WeakSet<ChildProcess>();
  private timer?: ReturnType<typeof setTimeout>;
  private jobs: Job<Args, Result>[] = [];
  private nextId = 0;
  private readonly options: ComputeWorkerOptions<Args>;

  constructor(options: ComputeWorkerOptions<Args>) {
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
    for (const child of this.children.values()) child.kill("SIGKILL");
    this.children.clear();
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
    for (const [key, cached] of this.children) if (cached === child) this.children.delete(key);
    for (const job of this.jobs.splice(0, preserveQueued ? 1 : this.jobs.length)) {
      if (job.deadline) clearTimeout(job.deadline);
      this.measure(job);
      job.reject(error);
    }
    // A timeout belongs to the active job. Younger queued requests still have
    // their own budget and must run on a fresh child instead of inheriting it.
    if (preserveQueued) this.dispatch();
  }

  private reference(child: ChildProcess, active: boolean): void {
    if (active) { child.ref(); child.channel?.ref(); }
    else { child.unref(); child.channel?.unref(); }
    // Native stdio pipes are also handles: an idle worker must not keep a CLI
    // alive. Node's pipe sockets expose ref/unref, but generic stream types do not.
    if (this.nativeChildren.has(child)) for (const pipe of [child.stdin, child.stdout]) {
      if (active && pipe && "ref" in pipe && typeof pipe.ref === "function") pipe.ref();
      if (!active && pipe && "unref" in pipe && typeof pipe.unref === "function") pipe.unref();
    }
  }

  private receive(child: ChildProcess, message: unknown): void {
    if (this.child !== child) return;
    const valid = typeof message === "object" && message !== null &&
      "id" in message && message.id === this.jobs[0]?.id &&
      (("result" in message && !("error" in message)) ||
        ("error" in message && typeof message.error === "string" && !("result" in message)));
    if (!valid) {
      if (this.nativeChildren.has(child)) {
        this.fail(this.unavailable(`${this.options.name} sent an invalid reply`, "protocol_error"));
      }
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const job = this.jobs.shift()!;
    if (job.deadline) clearTimeout(job.deadline);
    this.measure(job);
    const reply = message as Reply<Result>;
    if ("error" in reply) job.reject(new Error(reply.error));
    else job.resolve(reply.result);
    this.reference(child, false);
    if (this.jobs.length) this.dispatch();
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
      const executable = this.options.executableForArgs?.(this.jobs[0].args) ?? this.options.executable;
      const native = executable !== undefined;
      const key = native ? executable : "node-ipc";
      this.child = this.children.get(key);
      if (!this.child) {
        const child = native
          ? spawn(resolve(executable!), [...(this.options.executableArgs ?? [])], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true })
          : spawn(process.execPath, [
            ...(this.options.maxOldSpaceMb ? [`--max-old-space-size=${this.options.maxOldSpaceMb}`] : []),
            "--experimental-strip-types", "--experimental-sqlite", "--experimental-loader",
            pathToFileURL(resolve("scripts/ts-alias-loader.mjs")).href,
            resolve(this.options.entry),
          ], { serialization: "advanced", stdio: ["ignore", "inherit", "inherit", "ipc"], windowsHide: true });
        this.child = child;
        this.children.set(key, child);
        if (native) this.nativeChildren.add(child);
        if (child.pid) {
          try { setPriority(child.pid, 19); }
          catch (error) { console.warn(`${this.options.name} worker: failed to lower priority`, error); }
        }
        if (native) {
          let buffer = "";
          child.stdout!.setEncoding("utf8");
          child.stdout!.on("data", (chunk: string) => {
            if (this.child !== child) return;
            buffer += chunk;
            if (Buffer.byteLength(buffer) > 128 * 1024) {
              this.fail(this.unavailable(`${this.options.name} reply is too large`, "protocol_error"));
              return;
            }
            let newline: number;
            while ((newline = buffer.indexOf("\n")) !== -1) {
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              try { this.receive(child, JSON.parse(line)); }
              catch {
                this.fail(this.unavailable(`${this.options.name} sent an invalid reply`, "protocol_error"));
              }
              if (this.child !== child) return;
            }
          });
          for (const pipe of [child.stdin!, child.stdout!]) pipe.on("error", (error) => {
            if (this.child === child) this.fail(this.unavailable(error.message, "worker_io"));
          });
        } else child.on("message", (message: Reply<Result>) => this.receive(child, message));
        child.once("error", (error) => {
          if (this.children.get(key) === child) this.children.delete(key);
          if (this.child === child) this.fail(this.unavailable(error.message));
        });
        child.once("exit", (code, signal) => {
          if (this.children.get(key) === child) this.children.delete(key);
          if (this.child === child) {
            this.fail(this.unavailable(`${this.options.name} worker exited (${signal ?? code})`, "worker_exit"));
          }
        });
      }
      const child = this.child;
      this.reference(child, true);
      // Bound synchronous work in the child, including time spent waiting for SQLite.
      this.timer = setTimeout(() => {
        this.fail(this.unavailable(`${this.options.name} worker timed out`, "worker_timeout"), true);
      }, this.options.timeoutMs ?? 60_000);
      this.timer.unref();
      const { id, args } = this.jobs[0];
      this.jobs[0].dispatchedAt = performance.now();
      this.measure(this.jobs[0], false);
      const sent = (error: Error | null | undefined) => {
        if (error && this.child === child) this.fail(this.unavailable(error.message, "worker_io"));
      };
      if (native) {
        const frame = `${JSON.stringify({ version: 1, id, args })}\n`;
        if (Buffer.byteLength(frame) > 64 * 1024) {
          this.fail(this.unavailable(`${this.options.name} request is too large`, "protocol_error"), true);
          return;
        }
        child.stdin!.write(frame, sent);
      } else child.send({ id, args }, sent);
    } catch (error) {
      this.fail(this.unavailable(error instanceof Error ? error.message : String(error)));
    }
  }
}
