import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return nextResolve("next/server.js", context);
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

// The claim route signs and verifies real cookies, and both the review gate and
// the signing key are read from the environment at call time, so the feature is
// switched on here rather than stubbed out.
process.env.COMMUNITY_REVIEW_ENABLED = "true";
process.env.HELPER_COOKIE_SECRET = "a-helper-cookie-secret-with-32-characters";
const { NextRequest } = await import("next/server");
const { POST: claim } = await import("../app/api/community/ban-reviews/claim/route.ts");

const claimRequest = (cookie, ip) => new NextRequest("http://localhost/api/community/ban-reviews/claim", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-real-ip": ip,
    ...(cookie === undefined ? {} : { cookie: `seasonal_helper=${cookie}` }),
  },
  body: JSON.stringify({ limit: 3 }),
});

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

const cookieValue = (response) => {
  const header = response.headers.get("set-cookie");
  assert.ok(header, "the claim response carries no helper cookie");
  return header.split(";")[0].slice("seasonal_helper=".length);
};

test("the claim route mints an identity on a first visit and keeps it for the same cookie", async () => {
  const first = await claim(claimRequest(undefined, "203.0.113.1"));
  assert.equal(first.status, 200);
  const token = cookieValue(first);
  assert.deepEqual(await first.json(), { candidates: [{ aid: 100, reportCount: 2, lastReportedAt: 1 }] });
  const minted = store.calls.candidates.at(-1);
  assert.match(minted, /^[0-9a-f-]{36}$/);

  const again = await claim(claimRequest(token, "203.0.113.1"));
  assert.equal(again.status, 200);
  assert.equal(again.headers.get("set-cookie"), null, "a valid session must not be re-minted");
  assert.equal(store.calls.candidates.at(-1), minted, "the same cookie has to keep its own vote key");
});

test("the claim route fails closed on a helper cookie it cannot verify", async () => {
  const token = cookieValue(await claim(claimRequest(undefined, "203.0.113.2")));
  const corrupted = token.slice(0, -4) + (token.endsWith("AAAA") ? "BBBB" : "AAAA");
  const opened = store.calls.getCommunityReportsStore;
  const served = store.calls.candidates.length;

  const response = await claim(claimRequest(corrupted, "203.0.113.2"));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Invalid helper session" });
  // A new cookie here is the whole defect: the helper would vote under a fresh
  // identity, which deduplication on (helper_id, aid) cannot see.
  assert.equal(response.headers.get("set-cookie"), null, "a broken cookie must not be answered with a new identity");
  assert.equal(store.calls.getCommunityReportsStore, opened, "the rejection happens before the store is read");
  assert.equal(store.calls.candidates.length, served, "no identity was minted");
});

test("the claim route charges the rate limiter for a rejected cookie", async () => {
  const statuses = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    statuses.push((await claim(claimRequest("not-a-token", "203.0.113.3"))).status);
  }
  assert.deepEqual(statuses, Array(10).fill(401), "a rejected cookie costs budget instead of bypassing it");
  assert.equal((await claim(claimRequest("not-a-token", "203.0.113.3"))).status, 429);
});
