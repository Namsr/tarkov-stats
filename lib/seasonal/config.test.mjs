import assert from "node:assert/strict";
import test from "node:test";

import {
  isCommunityHelperEnabled,
  isCommunityReviewEnabled,
  isSeasonalCollectorReady,
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

test("the confirmed pvp-season JSON template uses the direct profile contract", () => {
  const cycle = loadSeasonalCycleConfig({
    ...valid,
    SEASONAL_PROFILE_URL_TEMPLATE: "https://players.tarkov.dev/pvp-season/{aid}.json",
  });
  assert.equal(cycle?.upstreamContract, "direct_profile");
  assert.equal(loadSeasonalCycleConfig(valid)?.upstreamContract, "game_mode");
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
  assert.equal(isCommunityReviewEnabled({ COMMUNITY_REVIEW_ENABLED: "true" }), false);
  assert.equal(isCommunityReviewEnabled({
    COMMUNITY_REVIEW_ENABLED: "true",
    HELPER_COOKIE_SECRET: "a-helper-cookie-secret-with-32-characters",
  }), true);
});

test("JSON feed configuration is opt-in and fail-closed", () => {
  assert.equal(loadSeasonalCycleConfig({ ...valid, SEASONAL_COLLECTION_SOURCE: "typo" }), null);
  assert.equal(isSeasonalRolloutReady({
    ...valid,
    SEASONAL_COLLECTION_SOURCE: "json_feed",
  }), false);
  const feed = {
    ...valid,
    SEASONAL_COLLECTION_SOURCE: "json_feed",
    SEASONAL_UPSTREAM_FIXTURE_CONFIRMED: "true",
    SEASONAL_PROFILE_UPDATED_URL: "https://players.tarkov.dev/pvp-season/updated.json",
    SEASONAL_PROFILE_INDEX_URL: "https://players.tarkov.dev/pvp-season/index.json",
  };
  assert.equal(loadSeasonalCycleConfig(feed)?.collectionSource, "json_feed");
  assert.equal(isSeasonalCollectorReady({ ...feed, SEASONAL_UPSTREAM_FIXTURE_CONFIRMED: "false" }), false);
  assert.equal(isSeasonalRolloutReady(feed), true);
  assert.equal(isSeasonalCollectorReady({ ...feed, SEASONAL_ENABLED: "false" }), true);
  assert.equal(isSeasonalRolloutReady({ ...feed, SEASONAL_ENABLED: "false" }), false);
  assert.equal(isSeasonalCollectorReady({
    ...feed,
    SEASONAL_ENABLED: "false",
    SEASONAL_STARTS_AT: "2099-01-01T00:00:00Z",
  }), false);
  assert.equal(isSeasonalRolloutReady({ ...feed, SEASONAL_PROFILE_INDEX_URL: "https://example.com/index.json" }), false);
});
