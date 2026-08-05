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
    assert.match(source, /if \(capture\.inserted\)/);
    assert.match(source, /refreshProgressionAfterCapture\([\s\S]*\{ force: true \}\)/);
  }
});
