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

// `request` wipes the whole SEASONAL_* namespace, so the snapshot has to cover
// every key that was present, not only the ones a case assigns.
function restoreSeasonalEnv(t) {
  const previous = Object.fromEntries(
    Object.keys(process.env)
      .filter((key) => key.startsWith("SEASONAL_"))
      .map((key) => [key, process.env[key]]),
  );
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("SEASONAL_")) delete process.env[key];
    }
    Object.assign(process.env, previous);
  });
}

test("a Seasonal cycle that has not rolled out answers 404, a bad cycle still answers 400", async (t) => {
  restoreSeasonalEnv(t);

  // Gate off (SEASONAL_ENABLED is "false"): nothing is exposed, so a client that
  // asks for the cycle must not be told it made a mistake. 400 here would make
  // a pre-rollout season indistinguishable from a client bug, which is what the
  // sibling routes on this gate already avoid (seasonal/cohort, progression,
  // progression/timeline, seasonal/progression, progression/average,
  // player/profile). Not every sibling answers this way yet, so this route does
  // not treat any of their current behaviour as a contract.
  const gated = await request("mode=seasonal&cycle=test-cycle", { ...ROLLED_OUT, SEASONAL_ENABLED: "false" });
  assert.equal(gated.status, 404);
  assert.equal(gated.headers.get("cache-control"), "no-store");
  assert.deepEqual(await gated.json(), { error: "Seasonal average unavailable" });

  // No cycle configured at all is the same absence, not a malformed request.
  const unconfigured = await request("mode=seasonal&cycle=test-cycle", {
    SEASONAL_CYCLE_ID: "",
    SEASONAL_PROFILE_URL_TEMPLATE: ROLLED_OUT.SEASONAL_PROFILE_URL_TEMPLATE,
  });
  assert.equal(unconfigured.status, 404);
  assert.equal(unconfigured.headers.get("cache-control"), "no-store");

  // The gate is on, so every remaining failure really is the request's fault.
  for (const query of [
    "mode=seasonal&cycle=stale-cycle",
    "mode=seasonal",
    "mode=seasonal&cycle=test-cycle&cycle=test-cycle",
    "mode=seasonal&cycle=",
  ]) {
    const invalid = await request(query, ROLLED_OUT);
    assert.equal(invalid.status, 400, query);
    assert.equal(invalid.headers.get("cache-control"), "no-store", query);
    assert.deepEqual(await invalid.json(), { error: "Invalid Seasonal cycle" }, query);
  }
});

test("a rolled-out cycle with a matching `cycle` still answers 200 with the public cache headers", async (t) => {
  restoreSeasonalEnv(t);

  // The gate must not cost the live case anything: with the gate fully on and
  // the requested cycle equal to the configured one, this stays the 200 it was
  // before the gate existed, with the same cache headers. Without this the fix
  // would be indistinguishable from simply disabling the route. No DB and no
  // network are needed: the baseline load degrades to storage: "unavailable"
  // and getAchievements already swallows its own failure.
  const live = await request("mode=seasonal&cycle=test-cycle", ROLLED_OUT);
  assert.equal(live.status, 200);
  assert.equal(live.headers.get("cache-control"), "public, max-age=300, s-maxage=300, stale-while-revalidate=3600");
  assert.deepEqual(await live.json(), { total: 0, achievements: [] });

  // Every error response is no-store, not only the gate's 404: the client fetches
  // this URL with default cache mode, so a cacheable 400 would be pinned in the
  // browser and the CDN after one bad request. `isGameMode` rejects the mode
  // before the seasonal branch, so this needs no cycle configuration.
  const badMode = await request("mode=bogus", ROLLED_OUT);
  assert.equal(badMode.status, 400);
  assert.equal(badMode.headers.get("cache-control"), "no-store");
});
