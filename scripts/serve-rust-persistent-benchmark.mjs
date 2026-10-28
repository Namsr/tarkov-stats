// Correctness fixture only. Real production Next and Rust are reached directly via Caddy.
// Both use the same private players/publications with independent production response caches.
import { createPersistentUiFixture, PERSISTENT_ASSETS_ROOT, assertPersistentPayload, assertPersistentParity, SEASONAL_UI_CYCLE } from "../tests/fixtures/rust-persistent-ui.mjs";
import { serveRustUiFixture } from "./lib/serve-rust-ui-fixture.mjs";
const seasonal = process.env.RUST_SEASONAL_BROWSER === "true";
const persistentQueries = ["pve", "regular"].flatMap(mode => {
  const base = `/api/average?mode=${mode}&statistic=trimmed_mean&period=all&dimension=hours&metric=players`;
  return [base + "&min=0", base];
});
const queries = seasonal ? [`/api/seasonal/average?cycle=${SEASONAL_UI_CYCLE}&statistic=trimmed_mean&period=all&dimension=hours&metric=players&min=0`, `/api/seasonal/average?cycle=${SEASONAL_UI_CYCLE}&statistic=trimmed_mean&period=all&dimension=hours&metric=players`] : persistentQueries;
await serveRustUiFixture({
  createFixture: async () => {
    const fixture = await createPersistentUiFixture({ prefix: seasonal ? "rust-seasonal-browser-" : "rust-persistent-browser-", rows: 300, includeArena: true, includeSeasonal: seasonal });
    if (seasonal) Object.assign(fixture.configured, { SEASONAL_POPULATION_UI_UPSTREAM: "web:3001", PVE_UI_UPSTREAM: "web:3000", REGULAR_UI_UPSTREAM: "web:3000" });
    return fixture;
  },
  assetsRoot: PERSISTENT_ASSETS_ROOT, requireNoReferenceFallback: seasonal,
  selectors: seasonal ? ["SEASONAL_POPULATION_UI_UPSTREAM"] : ["PVE_UI_UPSTREAM", "REGULAR_UI_UPSTREAM"],
  nextFlags: { PVE_UI_UPSTREAM: "web:3001", REGULAR_UI_UPSTREAM: "web:3001", SEASONAL_POPULATION_UI_UPSTREAM: seasonal ? "web:3001" : "web:3000", ARENA_UI_UPSTREAM: "web:3000",
    PVE_COHORT_BACKEND: "typescript", REGULAR_COHORT_BACKEND: "typescript" },
  pagePath: seasonal ? "/population/pvp-season" : "/population/pve", assetPrefix: "_rust/persistent", event: seasonal ? "rust_seasonal_browser_ready" : "rust_persistent_browser_ready",
  dataDescription: seasonal ? "private synthetic300 Seasonal profiles with latest snapshots/live hours, scheduled XP and eight bilingual achievements; shared progression DB" : "private synthetic300accounts perPvE/Regular + scheduled XP + eight bilingual achievements",
  warmCacheQueries: queries, assertPayload(body, label, query) {
    if (!seasonal) return assertPersistentPayload(body, label, query);
    if (body.mode !== "seasonal" || body.cycleId !== SEASONAL_UI_CYCLE || body.averages.n !== 300 || !body.buckets.length || !body.metricCounts.kd_ratio) throw new Error(`${label}: invalid Seasonal fixture response`);
  }, assertParity: assertPersistentParity,
  control(fixture, value) {
    if (value.action === "break-primary") {
      fixture.db.exec("ALTER TABLE players RENAME COLUMN kd_ratio TO fixture_missing_kd; ALTER TABLE mode_players RENAME COLUMN kd_ratio TO fixture_missing_kd");
    } else if (value.action === "repair-primary") {
      fixture.db.exec("ALTER TABLE players RENAME COLUMN fixture_missing_kd TO kd_ratio; ALTER TABLE mode_players RENAME COLUMN fixture_missing_kd TO kd_ratio");
    } else if (value.action) throw new Error("Unknown private control action");
  },
});
