import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
  assert.match(component, /load<unknown>\(cohortUrl\)\.then\(homeCohort\)/);
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
  assert.match(comparison, /body\.identity\?\.cycleId === cycleId/);
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
  assert.match(component, /loadPlayerProfileResponse<ShowcaseProfileResponse>\(profileUrl, \{ force \}\)/);
  assert.doesNotMatch(component, /loadPlayerProfileResponse<ShowcaseProfileResponse>\(`\/api\/player\/profile\?\$\{params\}`\)/);
  // The favorite panel has no retry button, so the user action that triggers the
  // request is the only way past a cached mismatched body.
  assert.match(comparison, /loadPlayerProfileResponse<HomeProfile>\(`\/api\/player\/profile\?\$\{params\}`, \{ force: true \}\)/);
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
