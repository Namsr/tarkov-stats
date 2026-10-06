/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript test runner requires explicit .ts imports.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRequestTiming, getObservabilitySampleRate } from "../lib/observability/request-timing.ts";

// Recording is asynchronous, but uses synchronous SQLite once opened. Keep
// these real writes off runtime databases even when a local /data exists.
const directory = mkdtempSync(join(tmpdir(), "request-timing-"));
process.env.ADMIN_ANALYTICS_SQLITE_PATH = join(directory, "analytics.db");
process.env.PROGRESSION_SQLITE_PATH = join(directory, "absent-progression.db");

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

test("Server-Timing reports the measured phases and nothing before finish", () => {
  let now = 0;
  const timing = createRequestTiming({ sampleRate: 1, now: () => now });
  // Nothing is finished yet, so there is nothing honest to report.
  assert.equal(timing.serverTiming(), null);

  now = 40;
  timing.finish({
    operation: "player_profile",
    mode: "regular",
    outcome: "success",
    status: 200,
    totalMs: 40,
    profileMs: 31.4,
    storeReadMs: 2.6,
    // A phase that was not measured must not appear, and neither must a
    // descriptor the header cannot carry safely.
    metadataMs: undefined,
    riskMs: 0,
    ...({ arbitrary: "dropped" } as object),
  });

  assert.equal(
    timing.serverTiming(),
    "profile;dur=31, storeread;dur=3, total;dur=40",
  );
  assert.equal(/[^\x20-\x7e]/.test(timing.serverTiming()), false, "header must stay ASCII");
});

test("Server-Timing always carries a total even with no measured phase", () => {
  const timing = createRequestTiming({ sampleRate: 1, now: () => 0 });
  timing.finish({ operation: "player_search", outcome: "success", status: 200, totalMs: 7 });
  assert.equal(timing.serverTiming(), "total;dur=7");
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

test("every profile response logs its validated account, including throttles, without raw input", () => {
  for (const status of [200, 400, 404, 429, 503]) {
    const output: string[] = [];
    const timing = createRequestTiming({ sampleRate: 0, now: () => 0, logger: (event) => output.push(event) });
    timing.setRequestContext({ aid: 5869253, aidState: "valid", cycleId: "persistent", nickname: "secret", host: "secret" });
    timing.finish({ operation: "player_profile", mode: "pve", outcome: status === 429 ? "rate_limited" : "success", status });
    timing.finish({ operation: "player_profile", outcome: "success", status });
    assert.equal(output.length, 1);
    const event = JSON.parse(output[0]);
    assert.equal(event.aid, 5869253);
    assert.equal(event.aid_state, "valid");
    assert.equal(event.cycle, "persistent");
    assert.equal(event.status, status);
    assert.equal(event.mode, "pve");
    assert.ok(Number.isFinite(event.at));
    assert.equal(output[0].includes("secret"), false);
  }
  for (const aidState of ["missing", "empty", "invalid"]) {
    const output: string[] = [];
    const timing = createRequestTiming({ sampleRate: 0, logger: (event) => output.push(event) });
    timing.setRequestContext({ aidState });
    timing.finish({ operation: "player_profile", outcome: "invalid", status: 400 });
    const event = JSON.parse(output[0]);
    assert.equal(event.aid, null);
    assert.equal(event.aid_state, aidState);
  }
});

test("a profile start records identity before a response and correlates through a validated request ID", () => {
  const output: string[] = [];
  const timing = createRequestTiming({ sampleRate: 0, logger: (event) => output.push(event) });
  const requestId = "11223344-5566-7788-9900-aabbccddeeff";
  timing.setRequestContext({ aid: 123, aidState: "valid", requestId, cycleId: "s1", nickname: "secret" });
  timing.startProfileRequest("seasonal");
  timing.startProfileRequest("seasonal");
  assert.equal(output.length, 1);
  const start = JSON.parse(output[0]);
  assert.equal(start.event, "profile_request_v1");
  assert.equal(start.aid, 123);
  assert.equal(start.request_id, requestId);
  assert.equal("status" in start, false);
  timing.finish({ operation: "player_profile", mode: "seasonal", outcome: "rate_limited", status: 429 });
  assert.equal(JSON.parse(output[1]).request_id, requestId);
  assert.equal(output.join("").includes("secret"), false);
});

test("unsampled cohort responses identify the target account and cycle without private context", () => {
  const output: string[] = [];
  const timing = createRequestTiming({ sampleRate: 0, logger: (event) => output.push(event) });
  timing.setRequestContext({ aid: 8014149, cycleId: "s1", nickname: "secret", host: "secret" });
  timing.finish({ operation: "average_cohort", mode: "seasonal", outcome: "error", status: 503 });
  assert.equal(output.length, 1);
  const event = JSON.parse(output[0]);
  assert.equal(event.aid, 8014149);
  assert.equal(event.cycle, "s1");
  assert.equal(event.status, 503);
  assert.equal(output[0].includes("secret"), false);
});

test("slow requests bypass sampling once, retaining SQL phases and excluding private context", () => {
  const output: string[] = [];
  const timing = createRequestTiming({ sampleRate: 0, now: () => 0, logger: (event) => output.push(event) });
  timing.setRequestContext({ aid: 123, nickname: "private-name", host: "private-host" });
  timing.finish({ operation: "average", outcome: "success", status: 200, totalMs: 1_000, storeReadMs: 900 });
  timing.finish({ operation: "average", outcome: "success", status: 200, totalMs: 2_000 });
  assert.equal(output.length, 1);
  const event = JSON.parse(output[0]);
  assert.equal(event.slow, true);
  assert.equal(event.pid, process.pid);
  assert.ok(Number.isFinite(event.at));
  assert.equal(event.total_ms, 1_000);
  assert.equal(event.store_read_ms, 900);
  assert.equal(output[0].includes("private"), false);
  assert.equal("aid" in event, false);
  const fast: string[] = [];
  createRequestTiming({ sampleRate: 0, now: () => 0, logger: (event) => fast.push(event) })
    .finish({ operation: "average", outcome: "success", status: 200, totalMs: 999 });
  assert.deepEqual(fast, []);
});

test("average compute timing forwards averages_ms and stays absent otherwise", async () => {
  const output: string[] = [];
  const timing = createRequestTiming({
    sampleRate: 1,
    now: () => 0,
    logger: (event) => output.push(event),
  });
  timing.finish({
    operation: "average",
    mode: "regular",
    outcome: "success",
    status: 200,
    source: "dynamic",
    cache: "miss",
    totalMs: 10,
    averagesMs: 7.6,
  });
  assert.equal(output.length, 1);
  assert.equal((JSON.parse(output[0]) as Record<string, unknown>).averages_ms, 8);

  // Explicit zero is preserved (not dropped as absent).
  const zeroed: string[] = [];
  createRequestTiming({ sampleRate: 1, now: () => 0, logger: (event) => zeroed.push(event) })
    .finish({ operation: "average", outcome: "success", status: 200, totalMs: 1, averagesMs: 0 });
  assert.equal((JSON.parse(zeroed[0]) as Record<string, unknown>).averages_ms, 0);

  // Operations without compute timing omit the field.
  const other: string[] = [];
  createRequestTiming({ sampleRate: 1, now: () => 0, logger: (event) => other.push(event) })
    .finish({ operation: "player_search", outcome: "success", status: 200, totalMs: 3 });
  assert.equal("averages_ms" in (JSON.parse(other[0]) as Record<string, unknown>), false);

  // finish() must forward averagesMs to the persisted request event.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile("lib/observability/request-timing.ts", "utf8");
  assert.match(source, /averagesMs: input\.averagesMs/);
});
