import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The store-served closures are reached from three call sites with two different
// labels. The short-circuit never calls upstream, so it is a hit. The two
// `force && waitForUpstream` fallbacks run only after `getPublicProfile(aid, {
// force: true })` has already bypassed the in-process cache, so they are a
// bypass even though the payload came from the store — and they still report a
// non-zero profile_ms. `origin/main` labelled them `bypass`; a flat `hit` made
// the admin cacheHitRate card count upstream-contacted refreshes as hits.
function assertStoreHitLabelFollowsUpstream(branch, label) {
  const calls = [...branch.matchAll(/storedResponse\(stored\)/g)].map((match) => match.index);
  assert.equal(calls.length, 3, `${label}: expected the short-circuit and both fallbacks`);
  const declared = branch.indexOf("let fetchedUpstream = false;");
  const upstream = branch.indexOf("fetchedUpstream = true;");
  assert.ok(declared >= 0, `${label}: the label needs a flag that starts out unset`);
  assert.ok(declared < calls[0], `${label}: the short-circuit must run before the flag is ever set, so it is a hit`);
  assert.ok(upstream > calls[0], `${label}: the flag is set at the upstream call, after the short-circuit`);
  assert.equal(
    branch.indexOf("fetchedUpstream = true;", upstream + 1),
    -1,
    `${label}: the flag is set exactly once and never reset, so both fallbacks see it`,
  );
  for (const fallback of calls.slice(1)) {
    assert.ok(upstream < fallback, `${label}: every fallback must be reached with the flag already set`);
  }
  const closure = branch.slice(
    branch.indexOf("const storedResponse = async (snapshot:"),
    branch.indexOf("if (stored && !(force && waitForUpstream)) {"),
  );
  assert.match(closure, /cache: fetchedUpstream \? "bypass" : "hit",/);
}

test("regular profile route answers a forced refresh from the store and re-fetches after the response", async () => {
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
  // but it only short-circuits the request when the caller did not ask to wait
  // for upstream.
  assert.doesNotMatch(storedPath, /if \(!force\) \{/);
  assert.match(storedPath, /if \(stored && !\(force && waitForUpstream\)\) \{\s*if \(force\) scheduleForcedProfileRefresh\("regular", aid\);\s*return await storedResponse\(stored\);/);
  // The re-fetch is deferred with after(), so the response never blocks on it.
  assert.match(source, /function scheduleForcedProfileRefresh\([^)]*\): void \{[\s\S]{0,200}after\(\(\) => \(mode === "pve"/);
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

  // The measured upstream latency is kept instead of dropped, so the two
  // labels have to be derived from the flag rather than hardcoded.
  assertStoreHitLabelFollowsUpstream(regular, "regular");
  assert.match(regular, /profileMs: profileMs \?\? \(profileStarted === undefined \? undefined : timing\.elapsedMs\(profileStarted\)\)/);
});

test("cached PvE profiles refresh only when their parser generation is old", async () => {
  const source = await readFile("app/api/player/profile/route.ts", "utf8");
  assert.match(source, /if \(stored && !\(force && waitForUpstream\)\) \{\s*if \(force\) \{\s*scheduleForcedProfileRefresh\("pve", aid\);\s*\} else if \(needsPvpStatsParserRefresh\(stored\.stats\)\) \{\s*after\(\(\) => refreshStoredPveProfile\(aid\)\)/);
  // Same store-served labelling as the regular branch: a hit when nothing went
  // upstream, a bypass on the `force && waitForUpstream` fallbacks.
  assertStoreHitLabelFollowsUpstream(
    source.slice(
      source.indexOf('if (mode === "pve") {'),
      source.indexOf("const storedStarted = timing.now();"),
    ),
    "pve",
  );
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

test("no player profile error response is cacheable", async () => {
  const source = await readFile("app/api/player/profile/route.ts", "utf8");
  // The client requests this URL with cache: "default", so a cacheable 404 or
  // 5xx would be pinned in the browser and CDN after one transient failure.
  // The point is that every error response is noStore, and this test is what
  // keeps it that way. 11 is the exact number of `{ status: <4xx|5xx>,
  // headers: X }` sites in the route: a lower bound let an unrelated subset
  // satisfy the loop while other sites regressed to profileHeaders, and it
  // would not catch a new error response added with cacheable headers.
  const responses = [...source.matchAll(/status:\s*(4\d\d|5\d\d)\s*,\s*headers:\s*([A-Za-z_$][\w$]*)/g)];
  assert.equal(responses.length, 11, `expected all 11 error responses, found ${responses.length}`);
  for (const [, status, headers] of responses) {
    assert.equal(headers, "noStore", `status ${status} must not be cacheable`);
  }
});
