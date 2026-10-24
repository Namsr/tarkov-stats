import assert from "node:assert/strict";
import test from "node:test";
import { previewRatio } from "../lib/leaderboard-preview.ts";

test("preview multipliers describe both directions without division by zero or invented metrics", () => {
  assert.deepEqual(previewRatio(5, 2), { direction: "above", ratio: 2.5 });
  assert.deepEqual(previewRatio(2, 2.6), { direction: "below", ratio: 2 / 2.6 });
  assert.deepEqual(previewRatio(9, 10), { direction: "below", ratio: 0.9 });
  assert.deepEqual(previewRatio(2, 2), { direction: "equal", ratio: 1 });
  assert.deepEqual(previewRatio(0, 0), { direction: "equal", ratio: 1 });
  assert.deepEqual(previewRatio(0, 2), { direction: "below", ratio: 0 });
  assert.deepEqual(previewRatio(2, 0), { direction: "above", ratio: null });
  assert.equal(previewRatio(null, 2), null);
  assert.equal(previewRatio(2, null), null);
  assert.equal(previewRatio(Number.NaN, 2), null);
  assert.equal(previewRatio(Number.POSITIVE_INFINITY, 2), null);
  assert.equal(previewRatio(-1, 2), null);
});
