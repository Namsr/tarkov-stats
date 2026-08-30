/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript test runner requires explicit .ts imports.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequestTiming, getObservabilitySampleRate, startTimingPhase } from "../lib/observability/request-timing.ts";

test("sampling defaults, validates, and clamps its configured rate", () => {
  assert.equal(getObservabilitySampleRate(undefined, "production"), 0.05);
  assert.equal(getObservabilitySampleRate(undefined, "test"), 0);
  assert.equal(getObservabilitySampleRate("not-a-number", "production"), 0.05);
  assert.equal(getObservabilitySampleRate("-2", "production"), 0);
  assert.equal(getObservabilitySampleRate("2", "production"), 1);
  assert.equal(getObservabilitySampleRate("0.25", "production"), 0.25);
});

test("timing events use only the explicit whitelist and rounded nonnegative milliseconds", () => {
  const output: string[] = [];
  let now = 10;
  const timing = createRequestTiming({
    sampleRate: 1,
    now: () => now,
    logger: (event) => output.push(event),
  });
  now = 12.6;
  timing.finish({
    operation: "average",
    mode: "regular",
    outcome: "success",
    status: 200,
    profileMs: 2.5,
    masteryMs: 1.5,
    totalMs: -1,
    ...({ aid: 5869253, arbitrary: "never logged" } as object),
  });

  assert.equal(output.length, 1);
  const event = JSON.parse(output[0]) as Record<string, unknown>;
  assert.deepEqual(Object.keys(event).sort(), [
    "entry", "event", "mastery_ms", "mode", "operation", "outcome", "profile_ms", "status", "total_ms",
  ]);
  assert.equal(event.total_ms, 0);
  assert.equal(event.profile_ms, 3);
  assert.equal(event.mastery_ms, 2);
});

test("synchronous store phases retain their direct durations after concurrent startup", async () => {
  let now = 0;
  const first = startTimingPhase(() => now, async () => {
    now += 3;
    return "first";
  });
  const second = startTimingPhase(() => now, async () => {
    now += 5;
    return "second";
  });
  const third = startTimingPhase(() => now, async () => {
    now += 7;
    return "third";
  });

  await Promise.resolve();
  const synchronous = [first.isSettled(), second.isSettled(), third.isSettled()];
  await Promise.all([first.promise, second.promise, third.promise]);
  assert.deepEqual(synchronous, [true, true, true]);
  assert.deepEqual([
    first.durationMs(synchronous[0]),
    second.durationMs(synchronous[1]),
    third.durationMs(synchronous[2]),
  ], [3, 5, 7]);
});

test("failure diagnostics keep only stable operation-scoped codes", () => {
  const output: string[] = [];
  const timing = createRequestTiming({ sampleRate: 1, logger: (event) => output.push(event) });
  timing.finish({
    operation: "player_profile",
    outcome: "unavailable",
    status: 503,
    storage: "unavailable",
    errorCode: "token for user@example.com",
  });
  const event = JSON.parse(output[0]) as Record<string, unknown>;
  assert.equal(event.failure_stage, "storage");
  assert.equal(event.error_code, "player_profile_unavailable_503");
  assert.equal(output[0].includes("example.com"), false);
});

test("unsampled requests emit no timing log", () => {
  const output: string[] = [];
  const timing = createRequestTiming({
    sampleRate: 0,
    random: () => { throw new Error("must not sample"); },
    logger: (event) => output.push(event),
  });
  timing.finish({ operation: "baseline", outcome: "success", status: 200 });
  assert.deepEqual(output, []);
});
