import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { superviseWorker } from "../scripts/supervise-worker.mjs";

test("worker crashes back off, recover, and cannot restart after shutdown", () => {
  const children = [];
  const timers = [];
  const cancelled = [];
  const priorities = [];
  let now = 0;
  const worker = superviseWorker("test", [], {
    spawn() {
      const child = Object.assign(new EventEmitter(), { pid: children.length + 1, kill(signal) { this.signal = signal; } });
      children.push(child);
      return child;
    },
    setTimeout(fn, ms) { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimeout(timer) { cancelled.push(timer); },
    setPriority(pid, priority) { priorities.push([pid, priority]); },
    now: () => now, log() {},
  });
  children[0].emit("error", new Error("spawn"));
  children[0].emit("close", 1, null);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 60_000);
  timers[0].fn();
  children[1].emit("close", null, "SIGABRT");
  assert.equal(timers[1].ms, 120_000);
  timers[1].fn();
  now = 600_000;
  children[2].emit("close", 1, null);
  assert.equal(timers[2].ms, 60_000);
  worker.stop();
  timers[2].fn();
  assert.equal(children.length, 3);
  assert.equal(children[2].signal, "SIGTERM");
  assert.deepEqual(cancelled, [timers[2]]);
  assert.deepEqual(priorities, [[1, 19], [2, 19], [3, 19]]);
});
