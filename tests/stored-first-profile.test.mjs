import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("regular profile route is stored-first and keeps forced refresh synchronous", async () => {
  const source = await readFile("app/api/player/profile/route.ts", "utf8");
  const storedBranch = source.search(/const storedStarted = timing\.now\(\);/);
  const upstreamBranch = source.indexOf("const result = await getPublicProfile(aid, { force });");
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
  assert.match(storedPath, /if \(stored && !force\) return await storedResponse\(stored\);/);
  assert.match(source, /progressionFlightKey\("regular", "persistent", aid\)/);
  assert.match(source, /singleFlight\(regularBackgroundRefreshes, key/);
  assert.match(source, /getPublicProfile\(aid, \{ force: true \}\)/);
});

test("a forced regular refresh degrades to the stored snapshot instead of 404 or 502", async () => {
  const source = await readFile("app/api/player/profile/route.ts", "utf8");
  const fallback = "if (stored) return await storedResponse(stored);";
  const regular = source.slice(source.indexOf("const storedStarted = timing.now();"));

  // An upstream throw is handled in a try scoped to getPublicProfile, so a
  // failure anywhere else in the request still reaches the 502 instead of being
  // logged as a 200 served from the store.
  const upstreamCall = regular.indexOf("const result = await getPublicProfile(aid, { force });");
  const upstreamCatch = regular.indexOf("} catch (error) {", upstreamCall);
  assert.ok(upstreamCall > 0 && upstreamCatch > upstreamCall, "getPublicProfile needs its own try");
  const scoped = regular.slice(upstreamCall, upstreamCatch);
  assert.ok(scoped.includes("await getPublicProfile(aid, { force })"));
  assert.match(
    regular.slice(upstreamCatch, upstreamCatch + 600),
    new RegExp(`${fallback.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*profileMs = timing\\.elapsedMs`),
    "the upstream catch falls back to the store and only then rethrows",
  );
  assert.match(regular.slice(upstreamCatch, upstreamCatch + 600), /throw error;/);

  // A null profile is a separate path from a throw, and also degrades.
  const notFound = regular.indexOf('"Profile not found. It may be private');
  assert.ok(regular.lastIndexOf(fallback, notFound) > regular.lastIndexOf("if (!profile) {", notFound),
    "the 404 branch must fall back to the stored snapshot first");

  // The outer catch no longer degrades: it is reached only when there is no
  // stored snapshot to degrade to.
  const failed = regular.indexOf('"Failed to fetch player profile"');
  const outerCatch = regular.lastIndexOf("} catch {", failed);
  assert.ok(outerCatch > 0, "the 502 catch must still exist");
  assert.doesNotMatch(regular.slice(outerCatch, outerCatch + 200), new RegExp(fallback.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  // Only the two genuine failure paths report absence.
  assert.equal(regular.split(fallback).length - 1, 2);

  // A forced fallback is a bypass, not a cache hit, and it keeps the measured
  // upstream latency instead of dropping it.
  assert.match(regular, /source: "stored",\s*cache: force \? "bypass" : "hit",/);
  assert.match(regular, /profileMs: profileMs \?\? \(profileStarted === undefined \? undefined : timing\.elapsedMs\(profileStarted\)\)/);
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
