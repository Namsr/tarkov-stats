import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Direct Node execution needs the extension.
import { createPercentileRank } from "../lib/seasonal/analytics.ts";

test("reused binary percentile ranks match the original definition, including ties and gaps", () => {
  for (const population of [[], [4], [1, 1, 1], [4, 1, 2, 2, 9, NaN, Infinity], Array.from({ length: 501 }, (_, i) => i % 17)]) {
    const rank = createPercentileRank(population);
    const finite = population.filter(Number.isFinite);
    for (let value = -1; value < 20; value += 0.5) {
      const below = finite.filter((entry) => entry < value).length;
      const equal = finite.filter((entry) => entry === value).length;
      const expected = finite.length === 0 ? null : finite.length === 1 ? 50
        : Math.max(0, Math.min(100, (below + Math.max(0, equal - 1) / 2) / (finite.length - 1) * 100));
      assert.equal(rank(value), expected);
    }
  }
});
