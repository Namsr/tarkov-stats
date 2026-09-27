import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const exists = (path) => access(path).then(() => true, () => false);

test("one catch-all route serves both legacy and canonical player URLs", async () => {
  assert.equal(await exists("app/player/[[...segments]]/page.tsx"), true);
  assert.equal(await exists("app/player/[aid]/page.tsx"), false);
  assert.equal(await exists("app/player/[mode]/[aid]/page.tsx"), false);
});

test("every direct Seasonal page and API entry point uses the full rollout gate", async () => {
  const directEntries = [
    "app/player/[[...segments]]/page.tsx",
    "app/average/[mode]/page.tsx",
    "app/api/player/profile/route.ts",
    "app/api/seasonal/progression/route.ts",
    "app/api/operator/seasonal/ban/route.ts",
    "app/api/operator/seasonal/profile/route.ts",
    "app/api/operator/seasonal/run/route.ts",
    "app/api/operator/seasonal/status/route.ts",
    "app/api/community-reports/route.ts",
  ];
  for (const path of directEntries) {
    assert.match(await readFile(path, "utf8"), /isSeasonalRolloutReady\(\)/, path);
  }

  const profileSync = await readFile("app/api/operator/seasonal/profile-sync/route.ts", "utf8");
  assert.match(profileSync, /isSeasonalCollectorReady\(\)/);
  assert.match(profileSync, /allowDisabledCycle: true/);
  assert.match(profileSync, /enabled: true/);

  const helperApi = await readFile("lib/seasonal/helper-api.ts", "utf8");
  assert.match(helperApi, /isCommunityHelperEnabled\(\)/);
  for (const source of [
    await readFile("app/api/player/profile/route.ts", "utf8"),
    await readFile("app/api/operator/seasonal/profile/route.ts", "utf8"),
    helperApi,
  ]) {
    assert.doesNotMatch(source, /refreshProgressionAfterCapture/);
  }

  const playerProfile = await readFile("app/api/player/profile/route.ts", "utf8");
  assert.match(
    playerProfile,
    /fetchPayload: \(\{ aid: seasonalAid, force: shouldForce \}\) =>\s*fetchSeasonalPayload\(seasonalAid, \{ force: shouldForce \}\)/,
  );
  assert.match(
    playerProfile,
    /result\.status === 404[\s\S]*?identity: \{ aid, mode, cycleId \}[\s\S]*?code: "mode_profile_unavailable"/,
  );
});

test("community reports refuse a Seasonal profile from a cycle that is not the live one", async () => {
  const reports = await readFile("app/api/community-reports/route.ts", "utf8");
  const gated = reports.slice(
    reports.indexOf('if (input.mode === "seasonal") {'),
    reports.indexOf('if (input.mode === "regular") {'),
  );

  // Fail-closed in the same four-part shape app/api/seasonal/cohort/route.ts uses,
  // and it must run before the store is opened, not after a snapshot is found.
  assert.match(
    gated,
    /if \(!isSeasonalRolloutReady\(\) \|\| !cycle \|\| cycle\.cycleId !== input\.cycleId \|\| !cycle\.enabled\) return false;/,
  );
  assert.ok(
    gated.indexOf("isSeasonalRolloutReady()") < gated.indexOf("getSeasonalStore()"),
    "the gate must precede the Seasonal store lookup",
  );
  // The caller only learns "Profile not found", so a gated cycle is
  // indistinguishable from an absent one.
  assert.match(gated, /return false;/);
  assert.doesNotMatch(gated, /cycle_unavailable|unavailable/);
  // The non-seasonal branches keep their existing lookups.
  assert.match(reports, /getProgressionStore\("regular"\)/);
  assert.match(reports, /getStore\(input\.mode as CrossSectionMode\)/);
});
