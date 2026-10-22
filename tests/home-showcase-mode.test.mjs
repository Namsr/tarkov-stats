import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";
import { isPlayerRiskCurrent, schedulePlayerRiskPoll } from "../lib/client-risk.ts";
import { showcaseTimelineCycle } from "../lib/home-showcase.ts";

const read = (path) => readFile(path, "utf8");

test("home showcase tabs cover every game mode and announce the group", async () => {
  const component = await read("components/HomePage.tsx");
  // Tabs are derived from GAME_MODES, so a new mode cannot be forgotten here.
  assert.match(component, /GAME_MODES\.map\(\(gameMode\)/);
  assert.match(component, /aria-pressed=\{gameMode === mode\}/);
  assert.match(component, /role="group" aria-label=\{t\("home\.showcaseMode"\)\}/);
  assert.match(component, /t\("fav\.mode\." \+ gameMode\)/);
});

test("home showcase renders the in-game portrait for the active mode", async () => {
  const [component, css] = await Promise.all([
    read("components/HomePage.tsx"),
    read("components/home/home.css"),
  ]);
  assert.match(component, /<ProfilePortrait/);
  assert.match(component, /aid=\{displayAid\}/);
  assert.match(component, /mode=\{displayMode\}/);
  assert.match(component, /cycleId=\{displayMode === "seasonal" \? seasonalCycleId/);
  assert.match(component, /import "@\/components\/profile\.css";/);
  assert.match(css, /\.home-profile-top \.profile-portrait \{[^}]*width/);
});

test("home showcase keeps the previous mode on screen while the next one loads", async () => {
  const [component, css] = await Promise.all([
    read("components/HomePage.tsx"),
    read("components/home/home.css"),
  ]);
  // No wipe to the loading panel on mode change: that collapses the section
  // and shifts the whole page on every switch.
  assert.doesNotMatch(component, /setProfile\(null\)/);
  assert.doesNotMatch(component, /setSnapshot\(null\)/);
  // Stale-while-revalidate: the previous mode's snapshot stays on screen and
  // keeps its own mode, so values never mix with the newly selected mode.
  assert.match(component, /snapshot\.mode === mode \? snapshot : null/);
  assert.match(component, /const display = current \?\? snapshot/);
  assert.match(component, /displayMode: GameMode = display\?\.mode \?\? mode/);
  assert.match(component, /aria-busy=\{switching/);
  assert.match(css, /\.home-showcase-switching \{[^}]*opacity/);
});

test("home showcase fetches per-mode data and degrades unsupported sections", async () => {
  const component = await read("components/HomePage.tsx");
  // Profile always loads for the selected mode; seasonal carries the cycle.
  // The query itself lives in the shared helper so the retry button can name the
  // same URL the effect requests.
  assert.match(component, /showcaseProfileRequest\(mode, aid, seasonalCycleId\)/);
  // Timeline and cohort capability come from the shared helpers: arena has no
  // timeline, and neither arena's match-metric cohort nor a cycle-less seasonal
  // config can feed the radar.
  assert.match(component, /showcaseTimelineCycle\(mode, seasonalCycleId\)/);
  assert.match(component, /showcaseCohortRequest\(mode, aid, seasonalCycleId\)/);
  assert.match(component, /cycle == null \? Promise\.resolve\(null\)/);
  assert.match(component, /cohortUrl == null \? Promise\.resolve\(null\)/);
  // The cohort payload is normalized at the boundary, so a mismatched shape
  // (arena metrics, error bodies) degrades instead of crashing the block.
  assert.match(component, /load\(cohortUrl, \(body\) => homeCohort\(body, identity\)/);
  assert.match(component, /loadAverageJson<unknown>\(url, \{/);
  assert.match(component, /signal: controller\.signal, forceRefresh: forceSecondary, retryUnavailable: true/);
  assert.match(component, /validHomeProgressionTimeline\(body, identity\)/);
});

test("home comparison block follows the displayed game mode", async () => {
  const [component, comparison] = await Promise.all([
    read("components/HomePage.tsx"),
    read("components/home/HomeComparison.tsx"),
  ]);
  // The block receives the snapshot's own mode and cycle, so a stale card never
  // compares against another mode's data.
  assert.match(component, /<HomeComparison profile=\{display\?\.profile\} cohort=\{display\?\.cohort\} gameMode=\{displayMode\} cycleId=\{display\?\.profile\?\.identity\.cycleId \?\? null\}/);
  // Favorites are global by AID: the picker must not hide pins stored under
  // another mode; only the radar fetch is scoped to the shown mode and cycle.
  assert.doesNotMatch(comparison, /favorite\.mode === gameMode/);
  assert.match(comparison, /new URLSearchParams\(\{ aid: String\(effectiveFavAid\), mode: gameMode \}\)/);
  assert.match(comparison, /if \(cycleId != null\) params\.set\("cycle", cycleId\)/);
  // The loaded favorite must come back for the same identity before it renders.
  assert.match(comparison, /body\.identity\?\.mode === gameMode/);
  assert.match(comparison, /body\.identity\?\.cycleId === \(cycleId \?\? "persistent"\)/);
  // The block used to be hardwired to the regular mode.
  assert.doesNotMatch(comparison, /favorite\.mode === "regular"/);
  assert.doesNotMatch(comparison, /mode=regular/);
  assert.match(comparison, /comparisonCohortMetricValue\(cohortStrategy, average \?\? \{ value: null, count: 0 \}\)/);
  assert.match(comparison, /finiteNonNegativeMetricValue\(profile\?\.comparisonStats\?\.\[metric\.stat\]\)/);
});

test("home showcase links and labels follow the displayed snapshot mode", async () => {
  const component = await read("components/HomePage.tsx");
  assert.match(component, /showcaseProfileHref\(displayMode, displayAid, seasonalCycleId\)/);
  assert.match(component, /t\("fav\.mode\." \+ displayMode\)/);
  // The opening mode comes from the admin-configured showcase, not a hardcoded one.
  assert.match(component, /setMode\(showcaseMode\(config\)\)/);
});

test("home showcase shows the faction beside the mode instead of the empty square", async () => {
  const [component, css, helpers] = await Promise.all([
    read("components/HomePage.tsx"),
    read("components/home/home.css"),
    read("lib/home-showcase.ts"),
  ]);
  // The 62px square stayed blank whenever a mode shipped no parsed stats (seasonal).
  assert.doesNotMatch(component, /home-faction/);
  assert.doesNotMatch(css, /\.home-faction/);
  // The faction is read from every known payload shape...
  assert.match(helpers, /export function homeProfileSide/);
  assert.match(component, /homeProfileSide\(display\?\.profile\)/);
  // ...and rendered next to the mode line, directly under the nickname.
  assert.match(component, /home-player-mode"><span>\{t\("fav\.mode\." \+ displayMode\)\}<\/span>\{side && <span className="home-player-side">\{side\}<\/span>\}/);
  assert.match(css, /\.home-player-mode \{[^}]*display: flex/);
  assert.match(css, /\.home-player-side \{[^}]*color/);
  assert.match(css, /\.home-player-side::before \{ content: "·"/);
});

test("home risk renders current Regular risk and preserves PvE's stored-risk fallback", async () => {
  const [component, route] = await Promise.all([
    read("components/HomePage.tsx"),
    read("app/api/player/profile/route.ts"),
  ]);
  assert.match(component, /<CheaterScore compact risk=\{display\?\.profile\?\.risk \?\? null\}[\s\S]*?mode=\{displayMode\}/);
  assert.match(route, /allowStaleRisk = request\.nextUrl\.searchParams\.get\("allowStaleRisk"\) === "1"/);
  assert.match(route, /scoreVersion === riskScoreVersion\("pve", cycleId\) \|\| allowStaleRisk/);
  const regularStart = route.indexOf("const storedStarted = timing.now();");
  assert.ok(regularStart >= 0, "Regular stored-profile branch exists");
  const regularRoute = route.slice(regularStart);
  assert.match(regularRoute, /const publicRisk = riskIsFresh/);
  assert.match(regularRoute, /const publicRiskView = riskIsFresh/);
  assert.doesNotMatch(regularRoute, /allowStaleRisk/);
});

test("the showcase retry bypasses the profile response cache on every click", async () => {
  const [component, comparison] = await Promise.all([
    read("components/HomePage.tsx"),
    read("components/home/HomeComparison.tsx"),
  ]);
  // A 200 can carry an identity that does not match the requested aid, and that
  // body is cached for its whole TTL. The retry has to name the exact URL it is
  // retrying, so the request is built outside the effect.
  assert.match(component, /const profileUrl = aid == null \? null : showcaseProfileRequest\(mode, aid, seasonalCycleId\)/);
  // Re-triggering rides on a counter, not on the retried URL: the second click
  // would set an Object.is-identical URL, React would bail out of the update and
  // no request would be issued at all.
  assert.match(component, /onClick=\{\(\) => \{ forceUrl\.current = profileUrl; setAttempt\(\(value\) => value \+ 1\); \}\}/);
  assert.match(component, /\}, \[aid, mode, attempt, profileUrl, seasonalCycleId\]\);/);
  // The armed URL lives in a ref on purpose: as state it would be a dependency,
  // and clearing it after a switch would re-run the effect, timeline and cohort
  // fetches included, a second time.
  assert.match(component, /const forceUrl = useRef<string \| null>\(null\);/);
  // force is on for exactly the load the button asked for and is dropped for any
  // other URL, so switching mode away and back reads the cache again instead of
  // spending a rate-limit slot on a load nobody requested.
  assert.match(component, /const force = forceUrl\.current === profileUrl;/);
  assert.match(component, /if \(!force\) forceUrl\.current = null;/);
  assert.match(component, /loadPlayerProfileResponse<ShowcaseProfileResponse>\(profileUrl, \{ force, signal: controller\.signal \}\)/);
  assert.doesNotMatch(component, /loadPlayerProfileResponse<ShowcaseProfileResponse>\(`\/api\/player\/profile\?\$\{params\}`\)/);
  // Ordinary favorite loads reuse the cache; only the explicit retry forces it.
  assert.match(comparison, /loadPlayerProfileResponse<HomeProfile>\(`\/api\/player\/profile\?\$\{params\}`, \{ force, signal: controller\.signal \}\)/);
});

test("home showcase achievement icons are the rarest unlocked ones", async () => {
  const component = await read("components/HomePage.tsx");
  assert.match(component, /import \{ rarestAchievements \} from "@\/lib\/profile-achievements";/);
  assert.match(component, /const ACHIEVEMENT_ICON_COUNT = 5;/);
  // The filter drops achievements without artwork, then the picker sorts the rest.
  assert.match(component, /rarestAchievements\(view\.achievements\.items\.filter\(achievementWithImage\), ACHIEVEMENT_ICON_COUNT\)/);
  // The strip used to render the first five ids the profile API happened to send.
  assert.doesNotMatch(component, /slice\(0, 5\)/);
});

test("home achievement alt text does not expose untranslated slugs", async () => {
  const component = await read("components/HomePage.tsx");
  assert.match(component, /const name = \(lang === "ru" \? item\.nameRu : item\.name\)\?\.trim\(\);/);
  assert.match(component, /const isSlug = name \? \/\^\[a-z0-9\]\+\(\?:-\[a-z0-9\]\+\)\*\$\/\.test\(name\) : false;/);
  assert.match(component, /name && name !== item\.id && !isSlug/);
  assert.match(component, /t\("home\.achievementIcon"\)/);
});


test("home showcase polls missing risk and only updates its originating snapshot", async () => {
  const component = await read("components/HomePage.tsx");
  assert.match(component, /scheduleArenaRiskPoll\(aid, arena.profile.profileUpdatedAt/);
  assert.match(component, /schedulePlayerRiskPoll\(\{/);
  assert.match(component, /profileUpdatedAt: profile.viewModel.freshness.profileUpdatedAt/);
  assert.match(component, /snapshot.mode !== mode/);
  assert.match(component, /profile.identity.cycleId !== cycleId/);
  assert.equal(component.match(/current === snapshot \?/g)?.length, 2);
  assert.match(component, /body.identity.cycleId !== \(cycle \?\? "persistent"\)/);
});


for (const mode of ["regular", "pve", "seasonal"]) {
  test(mode + " showcase polls unusable or stale existing risk and retains a fresh zero", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const component = await read("components/HomePage.tsx");
    const start = component.indexOf("    if (!snapshot || snapshot.mode !== mode || aid == null) return;");
    const end = component.indexOf("  }, [aid, mode, seasonalCycleId, snapshot]);", start);
    assert.ok(start >= 0 && end > start, "showcase risk effect must exist");
    const createEffect = new Function("snapshot", "mode", "aid", "seasonalCycleId", "showcaseTimelineCycle", "isPlayerRiskCurrent", "schedulePlayerRiskPoll", "scheduleArenaRiskPoll", "setSnapshot",
      "return () => { " + component.slice(start, end) + " };"
    );
    const aid = 8045310;
    const cycleId = showcaseTimelineCycle(mode, "kord-breach-s1");
    const now = Date.now();
    const fresh = { score: 0, available: true, availability: "available", profileUpdatedAt: 100, freshnessAt: now };
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return Response.json({ identity: { aid, mode, cycleId }, risk: fresh });
    });
    const cases = [
      ["missing", null, true],
      ["old unavailable", { ...fresh, score: null, available: false, availability: "unavailable", profileUpdatedAt: 99 }, true],
      ["unavailable flag", { ...fresh, available: false }, true],
      ["unavailable status", { ...fresh, availability: "unavailable" }, true],
      ["no score", { ...fresh, score: null }, true],
      ["non-finite score", { ...fresh, score: NaN }, true],
      ["old profile", { ...fresh, score: 80, profileUpdatedAt: 99 }, true],
      ["expired evaluation", { ...fresh, freshnessAt: now - 5 * 60 * 60 * 1000 }, true],
      ["fresh zero", fresh, false],
      ["fresh partial", { ...fresh, availability: "partial" }, false],
    ];
    for (const [name, risk, shouldPoll] of cases) {
      calls = 0;
      const profile = { identity: { aid, mode, cycleId }, viewModel: { freshness: { profileUpdatedAt: 100 } }, risk };
      const snapshot = { mode, profile, arena: null };
      let current = snapshot;
      const effect = createEffect(snapshot, mode, aid, "kord-breach-s1", showcaseTimelineCycle, isPlayerRiskCurrent, schedulePlayerRiskPoll,
        () => assert.fail("persistent showcase used Arena poller"), (update) => { current = update(current); });
      const cleanup = effect();
      t.mock.timers.tick(0);
      await new Promise(setImmediate);
      cleanup?.();
      assert.equal(calls, shouldPoll ? 1 : 0, name);
      assert.equal(current.profile.risk.score, shouldPoll ? 0 : risk.score, name);
      if (shouldPoll) assert.notEqual(current, snapshot, name);
      else assert.equal(current, snapshot, name);
    }
    // A completed request from the previous display cannot replace a newer snapshot.
    const snapshot = { mode, profile: { identity: { aid, mode, cycleId }, viewModel: { freshness: { profileUpdatedAt: 100 } }, risk: null }, arena: null };
    const replacement = { ...snapshot };
    let current = replacement;
    const cleanup = createEffect(snapshot, mode, aid, "kord-breach-s1", showcaseTimelineCycle, isPlayerRiskCurrent, schedulePlayerRiskPoll,
      () => assert.fail("persistent showcase used Arena poller"), (update) => { current = update(current); })();
    t.mock.timers.tick(0);
    await new Promise(setImmediate);
    cleanup?.();
    assert.equal(current, replacement);
    assert.equal(current.profile.risk, null);
  });
}


async function showcaseHarness(mode = "regular", retrySecondary = false) {
  const component = await read("components/HomePage.tsx");
  const start = component.indexOf("    if (profileUrl == null || aid == null) return;");
  const end = component.indexOf("  }, [aid, mode, attempt, profileUrl, seasonalCycleId]);", start);
  assert.ok(start >= 0 && end > start);
  const source = stripTypeScriptTypes(`function effect() {${component.slice(start, end)}}`);
  const pending = new Map();
  let current = { mode: "pve", profile: { identity: { aid: 99 } } };
  const previous = current;
  const updates = [];
  const aid = 8045310;
  const identity = { aid, mode, cycleId: "persistent" };
  const request = (url, options) => new Promise((resolve, reject) => pending.set(url, { resolve, reject, options }));
  const factory = new Function("loadPlayerProfileResponse", "loadAverageJson", "validHomeProgressionTimeline", "toArenaProfile", "homeCohort", "showcaseTimelineCycle", "showcaseCohortRequest", "profileUrl", "aid", "mode", "seasonalCycleId", "forceUrl", "secondaryForceUrl", "setSnapshot", source + "; return effect;");
  const effect = factory(request, request, () => true, (body) => body.arena, (body) => body,
    (mode) => mode === "arena" ? null : "persistent", (mode) => mode === "arena" ? null : "/cohort",
    "/profile", aid, mode, null, { current: null }, { current: retrySecondary ? "/profile" : null }, (update) => {
      current = typeof update === "function" ? update(current) : update;
      updates.push(current);
    });
  const cleanup = effect();
  const profile = { identity, viewModel: { freshness: { profileUpdatedAt: 100 } } };
  return { pending, profile, identity, previous, cleanup, updates, get current() { return current; } };
}

const flushShowcase = () => new Promise(setImmediate);
const timelineRequest = (harness) => [...harness.pending.entries()].find(([url]) => url.includes("/timeline?"))[1];

test("showcase publishes the profile while timeline and cohort are still pending", async () => {
  const h = await showcaseHarness();
  h.pending.get("/profile").resolve({ ok: true, body: h.profile });
  await flushShowcase();
  assert.equal(h.current.profile, h.profile, "secondary requests must not block the profile");
  assert.equal(h.current.timeline, undefined);
  assert.equal(h.current.cohort, undefined);
  const timeline = { metrics: {} };
  timelineRequest(h).resolve(timeline);
  await flushShowcase();
  assert.equal(h.current.timeline, timeline);
  assert.equal(h.current.cohort, undefined);
  const updated = { ...timeline, refreshed: true };
  timelineRequest(h).options.onUpdate(updated);
  h.pending.get("/cohort").resolve({ quality: "sufficient" });
  await flushShowcase();
  assert.equal(h.current.timeline, updated, "a later result must retain a refreshed timeline");
  assert.equal(h.current.cohort.quality, "sufficient");
  h.cleanup();
});

test("showcase retains the old mode until the profile arrives and preserves early secondary results", async () => {
  const h = await showcaseHarness();
  const cohort = { quality: "sufficient" };
  h.pending.get("/cohort").resolve(cohort);
  timelineRequest(h).reject(new Error("offline"));
  await flushShowcase();
  assert.equal(h.current, h.previous);
  h.pending.get("/profile").resolve({ ok: true, body: h.profile });
  await flushShowcase();
  assert.equal(h.current.profile, h.profile);
  assert.equal(h.current.timeline, null);
  assert.equal(h.current.cohort, cohort);
  h.cleanup();
});

test("showcase ignores results and background updates after a mode switch", async () => {
  const h = await showcaseHarness();
  h.cleanup();
  h.pending.get("/profile").resolve({ ok: true, body: h.profile });
  timelineRequest(h).resolve({ metrics: {} });
  h.pending.get("/cohort").options.onUpdate({ quality: "sufficient" });
  h.pending.get("/cohort").resolve(null);
  await flushShowcase();
  assert.equal(h.current, h.previous);
  assert.ok(h.pending.get("/profile").options.signal.aborted);
});

test("showcase exposes a failed profile without waiting for optional requests", async () => {
  const h = await showcaseHarness();
  h.pending.get("/profile").reject(new Error("offline"));
  await flushShowcase();
  assert.equal(h.current.mode, "regular");
  assert.equal(h.current.profile, null);
  assert.equal(h.current.timeline, null);
  assert.equal(h.current.cohort, null);
  h.cleanup();
});


test("home history retry bypasses cached invalid secondary data without forcing the profile", async () => {
  const h = await showcaseHarness("regular", true);
  assert.equal(h.pending.get("/profile").options.force, false);
  assert.equal(timelineRequest(h).options.forceRefresh, true);
  assert.equal(timelineRequest(h).options.maxUnavailableRetries, 2);
  h.cleanup();
});
