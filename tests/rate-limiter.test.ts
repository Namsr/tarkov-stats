/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript runner requires explicit .ts imports.
import assert from "node:assert/strict";
import test from "node:test";
import { checkRateLimit } from "../lib/rate-limiter.ts";

const HOUR = 3_600_000;

// Only the per-key window behaviour is asserted here. Whether prune reclaims a
// fully expired key is not observable from outside the module: the read path
// re-filters by the caller's own window either way, so `remaining` is identical
// whether or not the entry was deleted. Pinning it would need a test-only
// export of the store size, which is not worth widening the API for.

test("pruning a short-window bucket preserves the long-window bucket limit", () => {
  // Advance the clock past the short window while the long window is still active.
  const T0 = 4_102_444_800_000; // 2100-01-01T00:00:00Z
  const long = { bucket: "long", windowMs: HOUR, max: 5 };
  const short = { bucket: "short", windowMs: 1_000, max: 5 };

  for (let index = 0; index < 5; index += 1) {
    assert.equal(checkRateLimit("203.0.113.9", long, T0).allowed, true);
  }
  assert.equal(checkRateLimit("203.0.113.9", long, T0).allowed, false);

  // Short bucket at its own limit at T0, so the jump below has something to
  // forget. Without this the final "allowed" assertion would hold at any time.
  for (let index = 0; index < 5; index += 1) {
    assert.equal(checkRateLimit("10.0.0.1", short, T0).allowed, true);
  }
  assert.equal(checkRateLimit("10.0.0.1", short, T0).allowed, false);

  // Past the short window but nowhere near the long one.
  // Push the shared store past its 5000-key cleanup threshold.
  for (let index = 0; index < 5_100; index += 1) {
    checkRateLimit(`10.0.${Math.floor(index / 256)}.${index % 256}`, short, T0 + 1_100);
  }

  // The long bucket must still be at its limit: the prune ran 1100ms after its
  // timestamps, and the short window that triggered it must not reach them.
  assert.equal(checkRateLimit("203.0.113.9", long, T0 + 1_100).allowed, false);
  // And the short bucket still forgets on its own schedule.
  assert.equal(checkRateLimit("10.0.0.1", short, T0 + 1_100).allowed, true);
});
