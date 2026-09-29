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

const { GET } = await import("../app/api/player/risk/route.ts");
const { NextRequest } = await import("next/server");

// A fully configured, rolled-out cycle: the only variable between the cases below
// is the gate and the requested `cycle`.
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
  return GET(new NextRequest(`http://localhost/api/player/risk?aid=1&${query}`));
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
  // asks for the cycle must not be told it made a mistake. 400 here would make a
  // pre-rollout season indistinguishable from a client bug, which is what the 14
  // sibling routes on this gate already avoid (seasonal/average,
  // progression/average, player/profile, seasonal/progression, progression,
  // progression/timeline, the operator/seasonal family).
  const gated = await request("mode=seasonal&cycle=test-cycle", { ...ROLLED_OUT, SEASONAL_ENABLED: "false" });
  assert.equal(gated.status, 404);
  assert.deepEqual(await gated.json(), { error: "Seasonal risk unavailable" });

  // No cycle configured at all is the same absence, not a malformed request.
  const unconfigured = await request("mode=seasonal&cycle=test-cycle", {
    SEASONAL_CYCLE_ID: "",
    SEASONAL_PROFILE_URL_TEMPLATE: ROLLED_OUT.SEASONAL_PROFILE_URL_TEMPLATE,
  });
  assert.equal(unconfigured.status, 404);
  assert.deepEqual(await unconfigured.json(), { error: "Seasonal risk unavailable" });

  // The gate is on, so every remaining failure really is the request's fault.
  // A stale cycle, a malformed one, and a missing one are all 400s.
  for (const query of [
    "mode=seasonal&cycle=stale-cycle",
    "mode=seasonal&cycle=",
    "mode=seasonal",
  ]) {
    const invalid = await request(query, ROLLED_OUT);
    assert.equal(invalid.status, 400, query);
    assert.deepEqual(await invalid.json(), { error: "Invalid or missing cycle" }, query);
  }

  // Both gated answers must stay fail-closed: the rollout gate runs before
  // storage, so neither the 404 nor the 400 can read a warmed verdict. A
  // released cycle is the only case that reaches `getRiskEvaluation`, and the
  // row it cannot find stays a 200 with `risk: null`.
  const rolledOut = await request("mode=seasonal&cycle=test-cycle", ROLLED_OUT);
  assert.equal(rolledOut.status, 200);
  assert.deepEqual(await rolledOut.json(), {
    identity: { aid: 1, mode: "seasonal", cycleId: "test-cycle" },
    risk: null,
  });

  // The non-seasonal path is untouched: no gate, and the same `risk: null` answer.
  const regular = await request("", ROLLED_OUT);
  assert.equal(regular.status, 200);
  assert.deepEqual(await regular.json(), {
    identity: { aid: 1, mode: "regular", cycleId: "persistent" },
    risk: null,
  });
});
