import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/operator-auth") {
      return { shortCircuit: true, url: pathToFileURL(resolve("tests/fixtures/operator-auth-shim.mjs")).href };
    }
    if (specifier === "@/lib/community-reports-db") {
      return { shortCircuit: true, url: pathToFileURL(resolve("tests/fixtures/community-reports-store-shim.mjs")).href };
    }
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
    }
    return nextResolve(specifier, context);
  },
});

const store = await import("./fixtures/community-reports-store-shim.mjs");
const { GET } = await import("../app/api/operator/community-reviews/route.ts");
const call = (query) => GET(new Request(`http://localhost/api/operator/community-reviews${query}`));

test("the operator reviews route rejects a request without an aid", async () => {
  const opened = store.calls.getCommunityReportsStore;
  const response = await call("");
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "aid is required" });
  // The unfiltered query returns every account's review, so the rejection has
  // to happen before the store is opened, not after the query has run.
  assert.equal(store.calls.getCommunityReportsStore, opened);
});

test("the operator reviews route hands a supplied aid to the store", async () => {
  const opened = store.calls.getCommunityReportsStore;
  const response = await call("?aid=7");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    reviews: [{ aid: 7, reportCount: 1, yesCount: 0, noCount: 0, lastReportedAt: 1 }],
  });
  assert.equal(store.calls.getCommunityReportsStore, opened + 1);
});
