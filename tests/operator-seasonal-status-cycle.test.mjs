import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const shim = (name) => ({ shortCircuit: true, url: pathToFileURL(resolve(`tests/fixtures/${name}`)).href });

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/operator-auth") return shim("operator-auth-shim.mjs");
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
    }
    return nextResolve(specifier, context);
  },
});

const { GET: getStatus } = await import("../app/api/operator/seasonal/status/route.ts");

const BASE_ENV = {
  SEASONAL_CYCLE_ID: "test-cycle",
  SEASONAL_STARTS_AT: "2020-01-01T00:00:00Z",
  SEASONAL_UPSTREAM_CONTRACT: "game_mode",
  SEASONAL_ENABLED: "true",
  SEASONAL_PROFILE_URL_TEMPLATE: "https://players.tarkov.dev/{mode}/{aid}.json",
  SEASONAL_COLLECTION_SOURCE: "operator",
};

const status = (cycleId) => getStatus(new Request(
  `http://localhost/api/operator/seasonal/status?cycleId=${encodeURIComponent(cycleId)}`,
));

// `store.status` only validates the cycle-id syntax and reads rows for whatever
// cycle it is handed, so the route has to pin the configured cycle the way the
// run/refresh/profile routes do. A well-formed foreign cycle is a 409 conflict
// and a malformed one is a 400, not a 503 outage.
test("the operator seasonal status route refuses a cycle that is not the active one", async () => {
  Object.assign(process.env, BASE_ENV);
  const response = await status("other-cycle");
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "Seasonal cycle changed" });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("the operator seasonal status route reports a malformed cycleId as a 400", async () => {
  Object.assign(process.env, BASE_ENV);
  for (const cycleId of ["not a cycle", "../seasons", "!", "-"]) {
    const response = await status(cycleId);
    assert.equal(response.status, 400, cycleId);
    assert.deepEqual(await response.json(), { error: "Invalid cycleId" });
  }
});

test("the operator seasonal status route still requires a cycleId", async () => {
  Object.assign(process.env, BASE_ENV);
  const response = await getStatus(new Request("http://localhost/api/operator/seasonal/status"));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "cycleId is required" });
});
