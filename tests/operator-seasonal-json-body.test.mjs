import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const shim = (name) => ({ shortCircuit: true, url: pathToFileURL(resolve(`tests/fixtures/${name}`)).href });

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/operator-auth") return shim("operator-auth-shim.mjs");
    if (specifier === "next/cache") return shim("next-cache-shim.mjs");
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
    }
    return nextResolve(specifier, context);
  },
});

const { POST: postProfileSync } = await import("../app/api/operator/seasonal/profile-sync/route.ts");
const { POST: postRefresh } = await import("../app/api/operator/seasonal/refresh/route.ts");
const { POST: postRun } = await import("../app/api/operator/seasonal/run/route.ts");

const BASE_ENV = {
  SEASONAL_CYCLE_ID: "test-cycle",
  SEASONAL_STARTS_AT: "2020-01-01T00:00:00Z",
  SEASONAL_UPSTREAM_CONTRACT: "game_mode",
  SEASONAL_ENABLED: "true",
  SEASONAL_PROFILE_URL_TEMPLATE: "https://players.tarkov.dev/{mode}/{aid}.json",
};

// The gates read `process.env` per call, so each route gets the source it needs:
// profile-sync only serves the JSON feed, and run refuses to serve it.
const ROUTES = [
  ["profile-sync", postProfileSync, {
    SEASONAL_COLLECTION_SOURCE: "json_feed",
    SEASONAL_UPSTREAM_FIXTURE_CONFIRMED: "true",
    SEASONAL_PROFILE_UPDATED_URL: "https://players.tarkov.dev/updated.json",
    SEASONAL_PROFILE_INDEX_URL: "https://players.tarkov.dev/index.json",
  }],
  ["refresh", postRefresh, { SEASONAL_COLLECTION_SOURCE: "operator" }],
  ["run", postRun, { SEASONAL_COLLECTION_SOURCE: "operator" }],
];

// `Request.json()` resolves for a bare `null` body, so these used to reach the
// field reads as `null` and threw a TypeError outside the 400 handler.
const NON_OBJECT_BODIES = ["null", "42", '"seasonal"', "true"];

for (const [name, post, env] of ROUTES) {
  for (const body of NON_OBJECT_BODIES) {
    test(`the operator seasonal ${name} route rejects a ${body} body with 400`, async () => {
      Object.assign(process.env, BASE_ENV, env);
      const response = await post(new Request("http://localhost/api/operator/seasonal/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }));
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "Invalid JSON" });
    });
  }
}
