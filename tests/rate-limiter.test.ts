/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript runner requires explicit .ts imports.
import assert from "node:assert/strict";
import test from "node:test";
import { checkRateLimit } from "../lib/rate-limiter.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const HOUR = 3_600_000;

test("a bucket keeps its own window when another bucket triggers the shared prune", async () => {
  // The limiter's Map is keyed "<bucket>:<ip>" and holds every bucket, so the
  // opportunistic prune has to filter each key with its own windowMs. Using the
  // caller's window let a short-window bucket erase timestamps that were still
  // inside a long-window bucket's window, resetting that bucket's counter.
  for (let index = 0; index < 5; index += 1) {
    assert.equal(checkRateLimit("198.51.100.7", { bucket: "long", windowMs: HOUR, max: 5 }).allowed, true);
  }
  assert.equal(checkRateLimit("198.51.100.7", { bucket: "long", windowMs: HOUR, max: 5 }).allowed, false);

  // Past the short window but nowhere near the long one.
  await sleep(1_100);
  // Push the shared store past its 5000-key cleanup threshold using a short bucket.
  for (let index = 0; index < 5_100; index += 1) {
    checkRateLimit(`10.0.${Math.floor(index / 256)}.${index % 256}`, { bucket: "short", windowMs: 1_000, max: 5 });
  }

  // The long bucket must still be at its limit.
  assert.equal(checkRateLimit("198.51.100.7", { bucket: "long", windowMs: HOUR, max: 5 }).allowed, false);
  // And the short bucket still forgets on its own schedule.
  assert.equal(checkRateLimit("10.0.0.1", { bucket: "short", windowMs: 1_000, max: 5 }).allowed, true);
});

test("an expired bucket is reclaimed so the store stays bounded", async () => {
  for (let index = 0; index < 3; index += 1) {
    checkRateLimit("203.0.113.4", { bucket: "reclaim", windowMs: 50, max: 5 });
  }
  assert.equal(checkRateLimit("203.0.113.4", { bucket: "reclaim", windowMs: 50, max: 5 }).allowed, true);
  await sleep(120);
  assert.equal(checkRateLimit("203.0.113.4", { bucket: "reclaim", windowMs: 50, max: 5 }).remaining, 4);
});
