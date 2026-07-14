import assert from "node:assert/strict";
import test from "node:test";

import {
  isCommunityHelperEnabled,
  isSeasonalRolloutReady,
  loadSeasonalCycleConfig,
} from "./config.ts";

const valid = {
  SEASONAL_ENABLED: "true",
  SEASONAL_CYCLE_ID: "season-2026-01",
  SEASONAL_STARTS_AT: "2026-07-20T00:00:00+03:00",
  SEASONAL_UPSTREAM_CONTRACT: "game_mode",
  SEASONAL_PROFILE_URL_TEMPLATE: "https://players.tarkov.dev/account/{aid}",
};

test("Seasonal configuration is fail-closed until cycle and contract are complete", () => {
  assert.equal(loadSeasonalCycleConfig({ SEASONAL_ENABLED: "true" }), null);
  assert.equal(isSeasonalRolloutReady({ ...valid, SEASONAL_UPSTREAM_CONTRACT: "unknown" }), false);
  assert.equal(isSeasonalRolloutReady({ ...valid, SEASONAL_ENABLED: "false" }), false);
  assert.equal(isSeasonalRolloutReady({ ...valid, SEASONAL_PROFILE_URL_TEMPLATE: "" }), false);
  assert.equal(
    isSeasonalRolloutReady({ ...valid, SEASONAL_PROFILE_URL_TEMPLATE: "https://example.com/{aid}" }),
    false
  );
  assert.equal(isSeasonalRolloutReady(valid), true);
});

test("cycle dates are configured rather than hardcoded and helper has a second flag", () => {
  const cycle = loadSeasonalCycleConfig({ ...valid, SEASONAL_ENDS_AT: "1789000000" });
  assert.equal(cycle?.cycleId, "season-2026-01");
  assert.equal(cycle?.endsAt, 1_789_000_000_000);
  assert.equal(isCommunityHelperEnabled(valid), false);
  assert.equal(isCommunityHelperEnabled({ ...valid, COMMUNITY_HELPER_ENABLED: "true" }), false);
  assert.equal(isCommunityHelperEnabled({
    ...valid,
    COMMUNITY_HELPER_ENABLED: "true",
    HELPER_COOKIE_SECRET: "a-helper-cookie-secret-with-32-characters",
  }), true);
});
