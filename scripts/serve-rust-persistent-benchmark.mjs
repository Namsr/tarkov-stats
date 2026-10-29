// Correctness fixture only. Real production Next and Rust are reached directly via Caddy.
// Both use the same private players/publications with independent production response caches.
import { createPersistentUiFixture, PERSISTENT_ASSETS_ROOT, assertPersistentPayload, assertPersistentParity, persistentFixtureControl } from "../tests/fixtures/rust-persistent-ui.mjs";
import { serveRustUiFixture } from "./lib/serve-rust-ui-fixture.mjs";
const queries = ["pve", "regular"].flatMap(mode => {
  const base = `/api/average?mode=${mode}&statistic=trimmed_mean&period=all&dimension=hours&metric=players`;
  return [base + "&min=0", base];
});
await serveRustUiFixture({
  createFixture: () => createPersistentUiFixture({ prefix: "rust-persistent-browser-", rows: 300, includeArena: true }),
  assetsRoot: PERSISTENT_ASSETS_ROOT,
  selectors: ["PVE_UI_UPSTREAM", "REGULAR_UI_UPSTREAM"],
  nextFlags: { PVE_UI_UPSTREAM: "web:3001", REGULAR_UI_UPSTREAM: "web:3001", ARENA_UI_UPSTREAM: "web:3000",
    PVE_COHORT_BACKEND: "typescript", REGULAR_COHORT_BACKEND: "typescript" },
  pagePath: "/population/pve", assetPrefix: "_rust/persistent", event: "rust_persistent_browser_ready",
  dataDescription: "private synthetic300accounts perPvE/Regular + scheduled XP + eight bilingual achievements",
  warmCacheQueries: queries, assertPayload: assertPersistentPayload, assertParity: assertPersistentParity,
  control: persistentFixtureControl,
});
