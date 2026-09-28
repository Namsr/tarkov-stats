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
    "app/api/player/risk/route.ts",
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

test("the Seasonal refresh route reports a missing cycle and a missing owner differently", async () => {
  const refresh = await readFile("app/api/operator/seasonal/refresh/route.ts", "utf8");
  // `owner` is a required request field that is passed to every queue call, so
  // omitting it is a client error. A missing cycle stays a 409 server conflict.
  assert.match(refresh, /if \(!cycle\) return Response\.json\(\{ error: "Active Seasonal cycle is required" \}, \{ status: 409, headers \}\);/);
  assert.match(refresh, /if \(!owner\) return Response\.json\(\{ error: "owner is required" \}, \{ status: 400, headers \}\);/);
  assert.doesNotMatch(refresh, /!cycle \|\| !owner/);
  // The sibling operator route already reports the same class of problem as a 400.
  const run = await readFile("app/api/operator/seasonal/run/route.ts", "utf8");
  assert.match(run, /\{ error: "cycleId and owner are required" \}, \{ status: 400, headers \}/);
});

test("the player risk route gates Seasonal on the active cycle, not just on syntax", async () => {
  const risk = await readFile("app/api/player/risk/route.ts", "utf8");
  // `normalizeCycleId` accepts any well-formed cycle string, so without the gate a
  // request could read a verdict for a cycle the site does not expose — the JSON
  // collector warms exactly those rows before `isSeasonalRolloutReady()` is true.
  assert.match(risk, /if \(mode === "seasonal"\) \{/);
  assert.match(risk, /if \(!isSeasonalRolloutReady\(\) \|\| !cycle \|\| cycleId !== cycle\.cycleId\)/);
  // The gate has to run before storage is opened.
  assert.ok(
    risk.indexOf("isSeasonalRolloutReady()") < risk.indexOf("getRiskEvaluation("),
    "the rollout gate must precede the risk read",
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
