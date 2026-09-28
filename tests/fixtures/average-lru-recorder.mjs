// Wraps the real average LRU so a test can see which key each route asked for
// and whether that request actually computed anything. Real hit/miss behaviour
// is preserved: only the key and the loader invocation are observed, and the
// loader result comes from the real cache module.
import {
  loadDynamicAverage as realLoadDynamicAverage,
  resetDynamicAverageCacheForTests,
} from "../../lib/average-dynamic-cache.ts";

/** Keys passed to the LRU, in call order. */
export const requestedKeys = [];
/** Keys whose loader actually ran, i.e. LRU misses. */
export const computedKeys = [];

export function resetAverageLruRecorder() {
  requestedKeys.length = 0;
  computedKeys.length = 0;
}

export async function loadDynamicAverage(key, load, now) {
  requestedKeys.push(key);
  return realLoadDynamicAverage(key, async () => {
    computedKeys.push(key);
    return load();
  }, now);
}

export { resetDynamicAverageCacheForTests };
