import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("regular profile route is stored-first and keeps forced refresh synchronous", async () => {
  const source = await readFile("app/api/player/profile/route.ts", "utf8");
  const storedBranch = source.indexOf('if (!force) {\n    const storedStarted');
  const upstreamBranch = source.indexOf('const { profile, fromCache, fromEdgeCache } = await getPublicProfile(aid, { force })');
  assert.ok(storedBranch >= 0 && upstreamBranch > storedBranch);
  const storedPath = source.slice(storedBranch, upstreamBranch);
  assert.match(storedPath, /getProgressionStore\("regular"\)/);
  assert.match(storedPath, /await progressionStore\.latest\(aid\)/);
  assert.match(storedPath, /profile: null/);
  assert.match(storedPath, /capture: \{ inserted: false, status: "stored" \}/);
  assert.match(storedPath, /after\(\(\) => refreshStoredRegularProfile\(aid\)\)/);
  assert.doesNotMatch(storedPath, /await getPublicProfile/);
  assert.match(source, /progressionFlightKey\("regular", "persistent", aid\)/);
  assert.match(source, /singleFlight\(regularBackgroundRefreshes, key/);
  assert.match(source, /getPublicProfile\(aid, \{ force: true \}\)/);
});

test("achievement-heavy SQL is absent from request paths", async () => {
  for (const path of [
    "app/api/player/profile/route.ts",
    "app/api/average/achievements/route.ts",
    "lib/admin/risk-service.ts",
  ]) {
    const source = await readFile(path, "utf8");
    assert.doesNotMatch(source, /json_each\s*\(/i, path);
    assert.doesNotMatch(source, /WITH\s+expanded\s+AS/i, path);
  }
});
