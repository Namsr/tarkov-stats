import assert from "node:assert/strict";
import test from "node:test";
import nextConfig from "../next.config.ts";
import fileSystemCache from "next/dist/server/lib/incremental-cache/file-system-cache.js";

const FileSystemCache = fileSystemCache.default;

test("runtime fetch cache evicts by size without writing a tmpfs copy and keeps tag invalidation", async (t) => {
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  assert.equal(nextConfig.experimental.isrFlushToDisk, false);
  assert.equal(nextConfig.cacheMaxMemorySize, 50 * 1024 * 1024);
  assert.equal(nextConfig.images.maximumDiskCacheSize, 32 * 1024 * 1024);
  let writes = 0;
  const cache = new FileSystemCache({
    flushToDisk: nextConfig.experimental.isrFlushToDisk,
    // Scale the same native LRU budget down to avoid allocating 50 MiB in tests.
    maxMemoryCacheSize: nextConfig.cacheMaxMemorySize / 1024,
    serverDistDir: "/runtime-cache-test/server",
    revalidatedTags: [],
    fs: {
      readFile: async () => { throw new Error("ENOENT"); },
      mkdir: async () => { writes++; },
      writeFile: async () => { writes++; },
      writeFileAtomic: async () => { writes++; },
    },
  });
  const value = (body) => ({
    kind: "FETCH", data: { body, headers: {}, status: 200, url: "https://players.tarkov.dev/profile/42.json" },
    revalidate: 300, tags: ["runtime-cache-test"],
  });
  const context = { kind: "FETCH", tags: ["runtime-cache-test"], softTags: [] };
  await cache.set("first", value("a".repeat(30_000)), { fetchCache: true, tags: context.tags });
  assert.equal((await cache.get("first", context)).value.data.body.length, 30_000);
  await cache.set("second", value("b".repeat(30_000)), { fetchCache: true, tags: context.tags });
  assert.equal(await cache.get("first", context), null, "evicted data must not be restored from tmpfs");
  assert.equal((await cache.get("second", context)).value.data.body[0], "b");
  now += 1;
  await cache.revalidateTag(context.tags);
  assert.equal(await cache.get("second", context), null, "tag invalidation must still expire memory entries");
  assert.equal(writes, 0, "runtime data must never accumulate on the filesystem");
});