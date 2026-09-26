import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("regular profile route is stored-first and keeps forced refresh synchronous", async () => {
  const source = await readFile("app/api/player/profile/route.ts", "utf8");
  const storedBranch = source.search(/const storedStarted = timing\.now\(\);/);
  const upstreamBranch = source.indexOf('const { profile, fromCache, fromEdgeCache } = await getPublicProfile(aid, { force })');
  assert.ok(storedBranch >= 0 && upstreamBranch > storedBranch);
  const storedPath = source.slice(storedBranch, upstreamBranch);
  assert.match(storedPath, /getProgressionStore\("regular"\)/);
  assert.match(storedPath, /await progressionStore\.latest\(aid\)/);
  assert.match(storedPath, /profile: null/);
  assert.match(storedPath, /capture: \{ inserted: false, status: "stored" \}/);
  assert.match(storedPath, /after\(\(\) => refreshStoredRegularProfile\(aid\)\)/);
  assert.match(storedPath, /needsPvpStatsParserRefresh\(snapshot\.stats\)/);
  assert.doesNotMatch(storedPath, /await getPublicProfile/);
  // The snapshot is read unconditionally so the forced path can fall back to it,
  // but it only short-circuits the request when the read is not forced.
  assert.doesNotMatch(storedPath, /if \(!force\) \{/);
  assert.match(storedPath, /if \(stored && !force\) return storedResponse\(stored\);/);
  assert.match(source, /progressionFlightKey\("regular", "persistent", aid\)/);
  assert.match(source, /singleFlight\(regularBackgroundRefreshes, key/);
  assert.match(source, /getPublicProfile\(aid, \{ force: true \}\)/);
});

test("a forced regular refresh degrades to the stored snapshot instead of 404 or 502", async () => {
  const source = await readFile("app/api/player/profile/route.ts", "utf8");
  const fallback = "if (stored) return storedResponse(stored);";

  const notFound = source.indexOf('"Profile not found. It may be private');
  const notFoundGuard = source.lastIndexOf(fallback, notFound);
  assert.ok(notFoundGuard > 0, "the 404 branch must fall back to the stored snapshot first");
  assert.ok(source.lastIndexOf("if (!profile) {", notFound) < notFoundGuard, "the fallback belongs to the !profile branch");

  const failed = source.indexOf('"Failed to fetch player profile"');
  const failedGuard = source.lastIndexOf(fallback, failed);
  assert.ok(failedGuard > 0, "the catch branch must fall back to the stored snapshot first");
  assert.ok(source.lastIndexOf("} catch {", failed) < failedGuard, "the fallback belongs to the catch branch");

  // Only the two genuine failure paths report absence.
  assert.equal(source.split(fallback).length - 1, 2);
});

test("cached PvE profiles refresh only when their parser generation is old", async () => {
  const source = await readFile("app/api/player/profile/route.ts", "utf8");
  assert.match(source, /if \(stored && !force\) \{\s*if \(needsPvpStatsParserRefresh\(stored\.stats\)\) \{\s*after\(\(\) => refreshStoredPveProfile\(aid\)\)/);
  assert.match(source, /getPublicProfile\(aid, \{ force: true, mode: "pve" \}\)/);
  assert.match(source, /pveProfileDecision\(profile\)\.state !== "store"/);
  assert.match(source, /\{ mode: "pve", strict: true \}/);
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
  const averageAchievements = await readFile("app/api/average/achievements/route.ts", "utf8");
  assert.match(averageAchievements, /getPublishedSeasonalAchievementBaseline/);
  assert.doesNotMatch(averageAchievements, /getSeasonalAchievementBaseline/);
});
