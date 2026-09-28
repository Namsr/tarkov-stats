import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
    }
    try { return nextResolve(specifier, context); } catch (error) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const { GET } = await import("../app/api/average/achievements/route.ts");
const { NextRequest } = await import("next/server");

// A fully configured, rolled-out cycle: the only variable between the cases
// below is the gate and the requested `cycle`.
const ROLLED_OUT = {
  SEASONAL_ENABLED: "true",
  SEASONAL_CYCLE_ID: "test-cycle",
  SEASONAL_STARTS_AT: "2020-01-01T00:00:00Z",
  SEASONAL_UPSTREAM_CONTRACT: "game_mode",
  SEASONAL_COLLECTION_SOURCE: "operator",
  SEASONAL_PROFILE_URL_TEMPLATE: "https://players.tarkov.dev/{mode}/{aid}.json",
};

function request(query, env) {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("SEASONAL_")) delete process.env[key];
  }
  Object.assign(process.env, env);
  return GET(new NextRequest(`http://localhost/api/average/achievements?${query}`));
}

test("a Seasonal cycle that has not rolled out answers 404, a bad cycle still answers 400", async () => {
  // Gate off (SEASONAL_ENABLED is unset): nothing is exposed, so a client that
  // asks for the cycle must not be told it made a mistake. 400 here would make
  // a pre-rollout season indistinguishable from a client bug, which is exactly
  // what every sibling route (seasonal/average, seasonal/cohort, progression,
  // progression/timeline, progression/average, player/profile) already avoids.
  const gated = await request("mode=seasonal&cycle=test-cycle", { ...ROLLED_OUT, SEASONAL_ENABLED: "false" });
  assert.equal(gated.status, 404);
  assert.deepEqual(await gated.json(), { error: "Seasonal average unavailable" });

  // No cycle configured at all is the same absence, not a malformed request.
  const unconfigured = await request("mode=seasonal&cycle=test-cycle", {
    SEASONAL_CYCLE_ID: "",
    SEASONAL_PROFILE_URL_TEMPLATE: ROLLED_OUT.SEASONAL_PROFILE_URL_TEMPLATE,
  });
  assert.equal(unconfigured.status, 404);

  // The gate is on, so every remaining failure really is the request's fault.
  for (const query of [
    "mode=seasonal&cycle=stale-cycle",
    "mode=seasonal",
    "mode=seasonal&cycle=test-cycle&cycle=test-cycle",
    "mode=seasonal&cycle=",
  ]) {
    const invalid = await request(query, ROLLED_OUT);
    assert.equal(invalid.status, 400, query);
    assert.deepEqual(await invalid.json(), { error: "Invalid Seasonal cycle" }, query);
  }
});
