import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

// Cut one declaration out of a source file so an assertion about it cannot be
// satisfied by unrelated code further down. An unbounded gap between an anchor
// and the claim only proves the two tokens co-occur somewhere in the file in
// that order, which is how a matches() comparing the wrong field passed its own
// test. Same slice-then-assert shape tests/stored-first-profile.test.mjs uses;
// the two indexOf asserts are what stop a missing anchor from silently slicing
// the last character of the file.
function sliceDeclaration(source, start, end) {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `no declaration starts with ${JSON.stringify(start)}`);
  const to = source.indexOf(end, from);
  assert.ok(to > from, `${JSON.stringify(end)} is missing after ${JSON.stringify(start)}`);
  return source.slice(from, to);
}

test("favorites are global by AID while mode widgets project the preferred link into their current identity", async () => {
  const context = await readFile("lib/favorites/context.tsx", "utf8");
  const route = await readFile("app/api/favorites/route.ts", "utf8");
  const store = await readFile("lib/db.ts", "utf8");
  const schema = await readFile("lib/favorites-schema.ts", "utf8");
  const panel = await readFile("components/ProgressionPanel.tsx", "utf8");
  const radar = await readFile("components/PlayerRadarComparison.tsx", "utf8");

  // matches() is the only thing that decides which favourite a mutation touched,
  // so the AID comparison is asserted inside matches() and nowhere else.
  const matches = sliceDeclaration(
    context,
    "function matches(favorite: Favorite, aid: number): boolean {",
    "export function FavoritesProvider",
  );
  assert.match(matches, /return favorite\.aid === aid;/);
  assert.doesNotMatch(context, /favorite\.mode === id\.mode|favorite\.cycleId === id\.cycleId/);
  assert.match(context, /body: JSON\.stringify\(\{ aid, nickname, mode: id\.mode, cycle: id\.cycleId \}\)/);
  assert.ok((context.match(/if \(!res\.ok\) throw new Error\(\)/g) ?? []).length >= 4);
  assert.ok((context.match(/await refresh\(\)/g) ?? []).length >= 4);

  // The identity parsed from the request body has to be the one that reaches the
  // store, and both live in POST. The old gap was satisfied by a route that
  // pinned every account as regular/persistent.
  const post = sliceDeclaration(route, "export async function POST(", "export async function DELETE(");
  assert.match(post, /const identity = parseIdentity\(body\.mode, body\.cycle\);/);
  assert.match(post, /store\.add\(\s*g\.sub,\s*aid,[\s\S]{0,200}identity\s*\)/);
  assert.match(route, /store\.remove\(g\.sub, aid\)/);
  assert.ok((route.match(/Storage unavailable/g) ?? []).length >= 3);
  assert.match(route, /store\.setMain\(g\.sub, aid\)/);
  assert.match(route, /store\.setNote\(g\.sub, aid, clean\(body\.note, NOTE_MAX\)\)/);
  assert.doesNotMatch(route, /store\.(?:remove|setMain|setNote)\(g\.sub, aid,[^)]*identity/);

  // The per-user cap is a condition on the INSERT itself, not a count that lives
  // somewhere below it. The gap is capped at 400; the real distance is 231.
  const insertSql = sliceDeclaration(
    schema,
    "export const FAVORITE_INSERT_SQL",
    "export const FAVORITE_SET_MAIN_SQL",
  );
  assert.match(insertSql, /INSERT OR IGNORE INTO favorites[\s\S]{0,400}COUNT\(DISTINCT aid\)/);
  assert.match(schema, /SET is_main = CASE WHEN aid = \? THEN 1 ELSE 0 END/);
  assert.match(schema, /throw new Error\("Favorite insert was ignored unexpectedly"\)/);
  assert.equal((store.match(/prepare\(FAVORITE_INSERT_SQL\)/g) ?? []).length, 1);
  assert.equal((store.match(/prepare\(FAVORITE_SET_MAIN_SQL\)/g) ?? []).length, 1);
  assert.match(store, /favoriteInsertResult\(inserted\.changes/);
  assert.equal((store.match(/DELETE FROM favorites WHERE user_sub = \? AND aid = \?/g) ?? []).length, 1);
  assert.equal((store.match(/UPDATE favorites SET note = \? WHERE user_sub = \? AND aid = \?/g) ?? []).length, 1);
  assert.equal((store.match(/UPDATE favorites SET nickname = \? WHERE user_sub = \? AND aid = \?/g) ?? []).length, 1);

  for (const source of [panel, radar]) {
    assert.match(source, /favorites\.filter\(\(favorite\) => favorite\.aid !== aid\)/);
    assert.doesNotMatch(source, /favorite\.mode === mode && favorite\.cycleId === cycleId/);
  }
  assert.match(panel, /mode,\s*cycle: cycleId,\s*aid: String\(favorite\.aid\)/);
  assert.match(radar, /aid: String\(effectiveFavoriteAid\),\s*mode,\s*cycle: cycleId/);
  assert.match(radar, /const nextStats = payload\.comparisonStats \?\? payload\.stats/);
  assert.doesNotMatch(radar, /payload\.viewModel\?\.comparison \?\? payload\.stats/);
});

test("the favourites identity assertion rejects a matches() that compares the wrong field", async () => {
  const source = await readFile("lib/favorites/context.tsx", "utf8");
  const matches = sliceDeclaration(
    source,
    "function matches(favorite: Favorite, aid: number): boolean {",
    "export function FavoritesProvider",
  );
  // The real source satisfies the check, so a throw below is the mutation's doing.
  assert.match(matches, /return favorite\.aid === aid;/);

  // In-memory mutation only; nothing under lib/ or app/ is written. matches() now
  // identifies a favourite by nickname, and the decoy `favorite.aid === aid` sits
  // in an unrelated helper inside the same slice.
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const original = [
    "function matches(favorite: Favorite, aid: number): boolean {",
    "  return favorite.aid === aid;",
    "}",
  ].join(eol);
  const mutated = [
    "function matches(favorite: Favorite, aid: number): boolean {",
    "  return favorite.nickname === String(aid);",
    "}",
    "",
    "const sameAid = (favorite: Favorite, aid: number) => favorite.aid === aid;",
  ].join(eol);
  const buggy = source.replace(original, mutated);
  assert.notEqual(buggy, source, "the mutation must apply to the real source");

  const buggyMatches = sliceDeclaration(
    buggy,
    "function matches(favorite: Favorite, aid: number): boolean {",
    "export function FavoritesProvider",
  );
  assert.throws(() => {
    assert.match(buggyMatches, /return favorite\.aid === aid;/);
  });
  // The unbounded form the file used to carry still accepts that same mutant,
  // which is why it was replaced rather than tightened in place.
  assert.match(buggy, /function matches\(favorite: Favorite, aid: number\)[\s\S]*favorite\.aid === aid/);
});

test("every favorites response is no-store, so the CDN cannot replay a 401 or 503 to the next visitor", async () => {
  const route = await readFile("app/api/favorites/route.ts", "utf8");

  // The limiter stopped emitting headers of its own, so spreading `headers`
  // contributed nothing and every error branch shipped with no directive.
  assert.match(route, /const noStore = \{ "Cache-Control": "no-store" \}/);
  // Merged once in guard(), which is what the 14 mutation branches echo.
  assert.match(route, /return \{ ok: true, sub: user\.sub, headers: \{ \.\.\.headers, \.\.\.noStore \} \}/);
  // guard()'s own two rejections, plus GET's rate-limit/store/identity failures.
  assert.match(route, /status: 429, headers: \{ \.\.\.headers, \.\.\.noStore \}/);
  assert.match(route, /status: 401, headers: \{ \.\.\.headers, \.\.\.noStore \}/);
  assert.match(route, /status: 503, headers: \{ \.\.\.headers, \.\.\.noStore \}/);
  assert.match(route, /status: 400, headers: \{ \.\.\.headers, \.\.\.noStore \}/);
  // A new response must merge no-store or reuse g.headers, never the raw bag.
  assert.doesNotMatch(route, /\{ status: \d+, headers \}/);
  assert.doesNotMatch(route, /\{ headers \}\)/);
  assert.doesNotMatch(route, /NextResponse\.json\([^)]*\{ headers: headers \}/);
  // Keep the directive single-sourced rather than re-spelled at a return site.
  assert.equal((route.match(/"Cache-Control"/g) ?? []).length, 1);
  assert.doesNotMatch(route, /NextResponse\.json\([\s\S]{0,200}"Cache-Control"/);
});

test("seasonal profiles poll the risk-only endpoint after background evaluation", async () => {
  const [source, route] = await Promise.all([
    readFile("components/SeasonalPlayer.tsx", "utf8"),
    readFile("app/api/player/risk/route.ts", "utf8"),
  ]);
  assert.match(source, /const initialRisk = body\.viewModel\?\.risk \?\? body\.risk \?\? null/);
  assert.match(source, /const riskPollGeneration = useRef\(0\)/);
  assert.match(source, /const pollGeneration = \+\+riskPollGeneration\.current/);
  assert.equal((source.match(/void pollSeasonalRisk\(\{/g) ?? []).length, 2);
  assert.match(source, /riskPollGeneration\.current === pollGeneration/);
  // The bump has to happen inside the success path. Retiring the mount poll
  // before the request went out killed a poll that could still fill the risk
  // section, because a failed refresh never reaches the spawn site.
  const refresh = source.slice(source.indexOf("const refreshProfile = useCallback("));
  assert.ok(
    refresh.indexOf("setServerRisk(nextRisk);") < refresh.indexOf("const pollGeneration = ++riskPollGeneration.current"),
    "the mount poll must be retired after the refresh has written its risk",
  );
  assert.equal((refresh.match(/const pollGeneration = \+\+riskPollGeneration\.current/g) ?? []).length, 1);
  assert.match(source, /\/api\/player\/risk\?\$\{params\}/);
  assert.match(source, /cache: "no-store"/);
  assert.match(source, /if \(!body\.risk\) continue;/);
  assert.match(route, /getRateLimitHeaders\(getClientIp\(request\), \{ bucket: "player-risk", max: 30 \}\)/);
  assert.match(route, /status: 429/);
  assert.match(route, /getRiskEvaluation\(\{ aid, mode, cycleId \}\)/);
  assert.match(route, /scoreVersion === riskScoreVersion\(mode, cycleId\)/);
});

test("missing mode keeps the profile shell without mounting data sections", async () => {
  const source = await readFile("components/RegularPlayer.tsx", "utf8");
  const unavailableStart = source.indexOf("if (modeUnavailable)");
  const genericErrorStart = source.indexOf("if (error || !stats)");
  assert.ok(unavailableStart > 0 && genericErrorStart > unavailableStart);

  const unavailableUi = source.slice(unavailableStart, genericErrorStart);
  assert.match(source, /data\.code === "mode_profile_unavailable"/);
  assert.match(source, /profileSummary\?: ProfileSummary/);
  assert.match(unavailableUi, /<ProfileActions/);
  assert.match(unavailableUi, /profileSummary\?\.nickname/);
  assert.match(unavailableUi, /<StatCard key=\{label\} label=\{label\} value="\?" \/>/);
  assert.match(unavailableUi, /<ProfileModeSwitch|<ProfileActions/);
  assert.match(unavailableUi, /key=\{`\$\{aid\}:\$\{mode\}`\}[\s\S]*?onCheck=\{refreshProfile\}/);

  const labelLists = unavailableUi.match(/\? \[(.*?)\]\s*: \[(.*?)\];/s);
  assert.ok(labelLists);
  assert.equal(labelLists[1].match(/t\(/g)?.length, 4);
  assert.equal(labelLists[2].match(/t\(/g)?.length, 4);

  for (const component of [
    "PlayerRadarComparison",
    "CheaterScore",
    "EarlyUnlocks",
  ]) {
    assert.doesNotMatch(unavailableUi, new RegExp(`<${component}`));
  }
  assert.doesNotMatch(unavailableUi, /player\.raidStats|player\.progression|player\.skills/);
});

test("ordinary profile failures retain the generic error UI", async () => {
  const source = await readFile("components/RegularPlayer.tsx", "utf8");
  assert.match(source, /const unavailable = data\.code === "mode_profile_unavailable"/);
  // Anchored on the load effect's own `unavailable` branch: `refreshProfile` throws
  // the same shape, so an unanchored match would pass against either code path.
  assert.match(
    source,
    /const unavailable = data\.code === "mode_profile_unavailable"[\s\S]*?throw new Error\(data\.error \?\? translate\.current\("player\.loadError"\)\)/,
  );
  assert.match(source, /if \(error \|\| !stats\)[\s\S]*?\{error \|\| t\("player\.unknownError"\)\}/);
});

test("a language switch does not re-request the profile or discard a refresh", async () => {
  const [regular, seasonal, panel] = await Promise.all([
    readFile("components/RegularPlayer.tsx", "utf8"),
    readFile("components/SeasonalPlayer.tsx", "utf8"),
    readFile("components/ProgressionPanel.tsx", "utf8"),
  ]);

  // `t` is memoized on `lang`, so it changes identity on every EN/RU toggle. With it
  // in the dependency array the load effect re-ran, which bumps requestGeneration —
  // and an in-flight «Обновить» (wait=1, so it can run for seconds) then resolved to
  // "unchanged" for a result that had been thrown away.
  assert.doesNotMatch(regular, /\}, \[aid, mode, profileRequestUrl, t\]\);/);
  assert.match(regular, /\}, \[aid, mode, profileRequestUrl\]\);/);
  // The translator is read through a ref so the error strings stay current.
  assert.match(regular, /const translate = useRef\(t\);/);
  assert.match(regular, /useEffect\(\(\) => \{\s*\n\s*translate\.current = t;\s*\n\s*\}, \[t\]\);/);
  assert.equal((regular.match(/translate\.current\("player\.loadError"\)/g) ?? []).length, 4);
  // Only the load effect changes. `refreshProfile` is a useCallback, so a new `t`
  // just gives the button a new callback and re-runs nothing.
  assert.equal((regular.match(/\bt\("player\.loadError"\)/g) ?? []).length, 3);

  // Same defect on a seasonal profile, where the array also carried a `lang` the body
  // never read. `refreshProfile` keeps its own generation check, so the callback here
  // only needs the plain `t` to stay a useCallback.
  assert.doesNotMatch(seasonal, /\}, \[aid, cycleId, lang, profileRequestUrl, t\]\);/);
  assert.match(seasonal, /\}, \[aid, cycleId, profileRequestUrl\]\);/);
  assert.match(seasonal, /const translate = useRef\(t\);/);
  assert.match(seasonal, /useEffect\(\(\) => \{\s*\n\s*translate\.current = t;\s*\n\s*\}, \[t\]\);/);
  assert.equal((seasonal.match(/translate\.current\("seasonal\.profileUnavailable"\)/g) ?? []).length, 4);
  assert.match(seasonal, /if \(error instanceof PlayerProfileResponseError\) throw new Error\(t\("seasonal\.profileUnavailable"\)\)/);

  // The timeline parameters carry no language, so the fetch must not re-run for one.
  assert.doesNotMatch(panel, /\}, \[aid, cycleId, forceRefresh, mode, onRiskChange, profileUpdatedAt, refreshRevision, t\]\);/);
  assert.match(panel, /\}, \[aid, cycleId, forceRefresh, mode, onRiskChange, profileUpdatedAt, refreshRevision\]\);/);
  assert.match(panel, /const translate = useRef\(t\);/);

  // The favorite comparison in the same panel had the identical defect and was
  // missed: this effect aborts the in-flight request on entry, so `t` in its array
  // cancelled a running comparison and re-requested it with identical parameters.
  // Sliced on the effect's own markers so the render body's legitimate `t` calls
  // cannot satisfy or break the bare-`t` check in either direction.
  assert.doesNotMatch(panel, /\}, \[cycleId, eligibleFavorites, mode, selectedAid, t\]\);/);
  assert.match(panel, /\}, \[cycleId, eligibleFavorites, mode, selectedAid\]\);/);
  const compare = panel.slice(
    panel.indexOf("const favorite = eligibleFavorites.find((item) =>"),
    panel.indexOf("void loadSecondary();"),
  );
  assert.ok(compare.length > 0, "the favorite comparison effect must be present");
  assert.doesNotMatch(compare, /\bt\(/);
  assert.match(compare, /translate\.current\("progression\.compare\.playerId", \{ aid: favorite\.aid \}\)/);
  assert.match(compare, /throw new Error\(translate\.current\("progression\.compare\.error"\)\);/);
  // Both load effects now read the translator through the ref: two sites each.
  assert.equal((panel.match(/translate\.current\(/g) ?? []).length, 4);
});

test("the Seasonal reset keeps the header nickname without a render-phase side effect", async () => {
  const seasonal = await readFile("components/SeasonalPlayer.tsx", "utf8");

  // React updater functions must be pure: a nested setState runs during the render
  // phase, and React may invoke the updater for a render it throws away.
  assert.doesNotMatch(seasonal, /setProfile\(\(current\) => \{[\s\S]*?setDisplayNickname/);
  assert.match(seasonal, /if \(profile\?\.nickname\) setDisplayNickname\(profile\.nickname\);\s*\n\s*setProfile\(null\);/);
});

test("profile actions share a top edge and helper copy sits underneath", async () => {
  const regular = await readFile("components/RegularPlayer.tsx", "utf8");
  const seasonal = await readFile("components/SeasonalPlayer.tsx", "utf8");
  const shell = await readFile("components/ProfileShell.tsx", "utf8");
  const header = await readFile("components/ProfileHeader.tsx", "utf8");
  const styles = await readFile("app/globals.css", "utf8");
  const refresh = await readFile("components/RefreshButton.tsx", "utf8");
  const favorite = await readFile("components/FavoriteButton.tsx", "utf8");
  const report = await readFile("components/CheaterReportButton.tsx", "utf8");

  assert.match(regular, /className="profile-actions-grid"/);
  assert.match(styles, /\.profile-header__top \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(420px, 520px\)/);
  assert.match(styles, /\.profile-action__button \{[^}]*height: 48px !important;[^}]*display: flex;[^}]*align-items: center;[^}]*justify-content: center/);
  assert.match(styles, /html \{ scroll-behavior: smooth; \}/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{\s*html \{ scroll-behavior: auto; \}/);
  assert.match(header, /<h1 className="page-title break-words">/);
  assert.match(header, /profile-header__controls[\s\S]*profile-header__actions/);
  assert.doesNotMatch(styles, /\.profile-header__mode \{[^}]*border/);
  assert.match(shell, /<ProfileSectionNav[\s\S]*?<ProfileHeader/);
  assert.match(regular, /<ProfileShell[\s\S]*?overviewCards=\{regularOverviewCards\}/);
  assert.match(seasonal, /<ProfileShell[\s\S]*?overviewCards=\{/);
  assert.match(refresh, /profile-action__button !text-sm/);
  assert.equal((favorite.match(/profile-action__button/g) ?? []).length, 2);
  assert.match(favorite, /className="disabled-control-hint"[\s\S]*tabIndex=\{0\}[\s\S]*aria-describedby=\{authHintId\}/);
  assert.match(favorite, /role="tooltip" className="disabled-control-tooltip"/);
  assert.doesNotMatch(favorite, /profile-action__status">\s*\{t\("fav\.authRequired"\)\}/);
  assert.match(report, /className="ghost-button profile-action__button/);
  assert.match(report, /className="report-count">\(\{count\}\)/);
  assert.match(report, /className="disabled-control-hint"[\s\S]*tabIndex=\{0\}[\s\S]*aria-describedby=\{authHintId\}/);
  assert.match(report, /role="tooltip" className="disabled-control-tooltip"/);
  assert.doesNotMatch(report, /signedOut && <span className="profile-action__status"/);
});

test("favorite limit message owns its dismiss timer", async () => {
  const favorite = await readFile("components/FavoriteButton.tsx", "utf8");

  // The status line used to schedule a bare setTimeout from the click handler:
  // the timer was retained after unmount (a post-unmount setState is a no-op on
  // React 19), and a second limit hit inside the window raced the first timer
  // and took the newer message away early.
  assert.match(
    favorite,
    /useEffect\(\(\) => \{\s*if \(!msg\) return;[\s\S]*?window\.setTimeout\(\(\) => setMsg\(""\), 3000\);\s*return \(\) => window\.clearTimeout\(timeout\);/,
  );
  assert.doesNotMatch(favorite, /setMsg\("fav\.limit"[^\n]*\n[^\n]*setTimeout/);
  // Identical copy on every hit means msg alone cannot restart the timer, so the
  // effect needs the per-hit counter as a dependency and the handler must bump it.
  assert.match(favorite, /\[msg, msgSeq\]\);[\s\S]*?setMsgSeq\(\(n\) => n \+ 1\);/);
});

test("profile omits empty skills anchors and keeps achievements full width", async () => {
  const skills = await readFile("components/ProfileSkills.tsx", "utf8");
  const regular = await readFile("components/RegularPlayer.tsx", "utf8");
  const seasonal = await readFile("components/SeasonalPlayer.tsx", "utf8");
  const achievements = await readFile("components/ProfileAchievements.tsx", "utf8");

  assert.match(skills, /export function hasVisibleSkills\(skills: readonly unknown\[\] \| null \| undefined\)/);
  assert.match(skills, /normalizeProfileSkill\(skill\) !== null/);
  assert.match(regular, /hasVisibleSkills\(regularSkillItems\)\s*\?\s*<ProfileSkills/);
  assert.match(seasonal, /hasVisibleSkills\(skillItems\)\s*\?\s*<ProfileSkills/);
  assert.match(achievements, /className="achievement-table-wrap"/);
  assert.doesNotMatch(achievements, /<aside>[\s\S]*<EarlyUnlocks/);
});

test("early unlocks keep a zero-hour anchor out of the panel", async () => {
  const earlyUnlocks = await readFile("components/EarlyUnlocks.tsx", "utf8");

  // A published 0 means the owner pool has no playtime data, not that owners
  // unlocked unusually early. The floor stays and the reason is recorded next to
  // it; the panel only runs for players with hours > 0, so a 0 anchor could never
  // clear the z threshold anyway.
  assert.match(earlyUnlocks, /const MIN_EARLY_HOURS = 200;/);
  assert.match(earlyUnlocks, /a\.earlyHours >= MIN_EARLY_HOURS &&/);
  assert.doesNotMatch(earlyUnlocks, /a\.earlyHours >= 200/);
  assert.match(earlyUnlocks, /z: \(playerHours - a\.earlyHours\) \/ a\.stdHours/);
});

test("profile achievements use sortable desktop columns and readable mobile cards", async () => {
  const achievements = await readFile("components/ProfileAchievements.tsx", "utf8");
  const collapsible = await readFile("components/ProfileCollapsible.tsx", "utf8");
  const styles = await readFile("app/globals.css", "utf8");
  const dictionary = await readFile("lib/i18n/dictionary.ts", "utf8");

  assert.match(achievements, /<table className="achievement-table">/);
  assert.match(achievements, /achievement\.col\.description/);
  assert.match(achievements, /aria-sort=\{sortAriaValue/);
  assert.match(achievements, /import Image from "next\/image"/);
  assert.match(achievements, /<Image[\s\S]*?alt=""/);
  assert.match(achievements, /width=\{56\}[\s\S]*?height=\{56\}/);
  assert.match(achievements, /loading="lazy"/);
  assert.match(achievements, /referrerPolicy="no-referrer"/);
  assert.match(achievements, /achievement\.samplePrimary/);
  assert.match(achievements, /achievement\.bsgLine/);
  assert.match(achievements, /useState<AchievementSortKey>\("percent"\)/);
  assert.match(achievements, /key: "percent"/);
  assert.match(achievements, /achievement-table__number-header/);
  assert.match(achievements, /<div className="achievement-cards" role="list">/);
  assert.match(achievements, /const ACHIEVEMENT_PREVIEW_COUNT = 3/);
  assert.match(collapsible, /aria-expanded=\{expanded\}/);
  assert.match(achievements, /controls=\{collapseId\}/);
  assert.match(achievements, /profile-collapsible__preview-tail/);
  assert.match(achievements, /achievement\.expand/);
  assert.match(collapsible, /content\.scrollHeight/);
  assert.match(collapsible, /row\.inert = hidden/);
  assert.match(collapsible, /positions\[previewRows\]/);
  assert.match(collapsible, /observer\.observe\(content\)/);
  assert.doesNotMatch(collapsible, /observer\.observe\(node\)/);
  assert.match(styles, /\.achievement-table-wrap \{[^}]*overflow-x: auto/);
  assert.match(styles, /\.achievement-table thead th\.achievement-table__number-header \{ text-align: right; \}/);
  assert.match(styles, /\.achievement-table__number-header \.achievement-table__sort \{ width: 100%; justify-content: flex-end; text-align: right; \}/);
  assert.match(styles, /@media \(max-width: 767px\)[\s\S]*\.achievement-table-wrap \{ display: none; \}/);
  assert.match(styles, /@media \(max-width: 767px\)[\s\S]*\.achievement-cards \{ display: grid/);
  assert.match(styles, /\.achievement-collapsible__content \{[^}]*--profile-collapsible-collapsed-height: 360px;/);
  assert.match(styles, /\.achievement-collapsible__content \{[^}]*overflow-anchor: none;/);
  assert.match(styles, /\.achievement-collapsible__content \.profile-collapsible__inner \{ overflow-anchor: none; \}/);
  assert.match(styles, /\.achievement-collapsible__content \{[^}]*transition: max-height 760ms/);
  assert.match(styles, /\.achievement-collapsible__content\.is-collapsed \{[^}]*transition: max-height 920ms/);
  assert.doesNotMatch(styles, /\.mastering-collapsible__content \{[^}]*transition:/);
  assert.match(styles, /@media \(max-width: 767px\)[\s\S]*\.mastering-collapsible__content \{ --profile-collapsible-collapsed-height: 640px; \}/);
  assert.match(styles, /\.profile-collapsible__content\.is-collapsed::after \{[^}]*height: 64px/);
  assert.match(styles, /\.profile-collapsible__content\.is-collapsed::after/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*profile-collapsible__content/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.achievement-collapsible__content\.is-collapsed \{ transition-duration: \.01ms; \}/);
  assert.match(dictionary, /"achievement\.col\.name": "Name"/);
  assert.match(dictionary, /"achievement\.col\.name": "Название"/);
  assert.match(dictionary, /"achievement\.sortBy":/);
});

test("average profiles always reuse the responsive profile achievements section", async () => {
  const page = await readFile("app/average/page.tsx", "utf8");
  const breakdown = await readFile("components/AchievementBreakdown.tsx", "utf8");
  const achievements = await readFile("components/ProfileAchievements.tsx", "utf8");
  const route = await readFile("app/api/average/achievements/route.ts", "utf8");
  const dictionary = await readFile("lib/i18n/dictionary.ts", "utf8");

  assert.doesNotMatch(page, /showAch|openBreakdown|average\.showAchBreakdown/);
  assert.match(page, /mode !== "arena" && \([\s\S]*<AchievementBreakdown[\s\S]*mode=\{mode\}[\s\S]*cycleId=\{cycleId\}/);
  assert.doesNotMatch(page, /<AchievementBreakdown[\s\S]*open=|<AchievementBreakdown[\s\S]*onToggle=/);
  assert.match(page, /function renderMetric[\s\S]*<StatCard/);
  assert.doesNotMatch(page, /metric\.key !== "achv_count"|title=\{t\("average\.showAchBreakdown"\)\}/);

  assert.match(breakdown, /type AchievementMode = Extract<GameMode, "regular" \| "pve" \| "seasonal">/);
  assert.match(breakdown, /<ProfileAchievements[\s\S]*variant="average"/);
  assert.match(breakdown, /setAttempt\(\(value\) => value \+ 1\)/);
  assert.match(breakdown, /role="alert"/);
  assert.doesNotMatch(breakdown, /query|filterPlaceholder|<input|onToggle|aria-expanded/);

  assert.match(achievements, /variant\?: "profile" \| "average"/);
  assert.match(achievements, /const AVERAGE_COLUMNS[\s\S]*key: "hours"[\s\S]*achievement\.col\.unlockTime/);
  assert.match(achievements, /variant === "average" && \(normalized\.owners \?\? 0\) <= 0/);
  assert.match(achievements, /variant === "average" && <th scope="col">/);
  assert.match(achievements, /formatHours\(achievement\.unlockHours/);

  assert.match(route, /nameRu: m\?\.nameRu \?\? null/);
  assert.match(route, /description: m\?\.descriptionEn \?\? null/);
  assert.match(route, /descriptionRu: m\?\.descriptionRu \?\? null/);
  assert.match(route, /imageUrl: m\?\.imageUrl \?\? null/);
  assert.match(route, /unlockHours: r\.unlockHours/);
  assert.match(dictionary, /"achievement\.col\.unlockTime": "Unlock time"/);
  assert.match(dictionary, /"achievement\.col\.unlockTime": "Время получения"/);
  assert.match(dictionary, /"achv\.retry": "Try again"/);
  assert.match(dictionary, /"achv\.retry": "Повторить"/);
});

test("achievement icon host is allowed by the production CSP", async () => {
  const config = await readFile("next.config.ts", "utf8");
  assert.match(config, /img-src 'self' blob: data: https:\/\/lh3\.googleusercontent\.com https:\/\/assets\.tarkov\.dev/);
  assert.match(config, /remotePatterns:[\s\S]*?protocol: "https"[\s\S]*?hostname: "assets\.tarkov\.dev"[\s\S]*?pathname: "\/\*\*"/);
});

test("achievement icons bypass the image optimizer and load from the asset CDN", async () => {
  // Домен стоит DNS-only, без Cloudflare перед приложением, поэтому каждый
  // /_next/image — полный круг до origin, и на холодном кэше иконка ехала
  // ~0.6 с. Официальный webp уже меньше выхода оптимизатора, так что он давал
  // нулевую пользу. assets.tarkov.dev отдаёт эти файлы с edge-кэша и уже
  // разрешён img-src (см. тест выше), как и иконки навыков в ProfileSkills.
  const source = await readFile("components/ProfileAchievements.tsx", "utf8");
  const icon = source.slice(source.indexOf("function AchievementIcon"), source.indexOf("function AchievementPercentage"));
  assert.match(icon, /unoptimized/);
  const skills = await readFile("components/ProfileSkills.tsx", "utf8");
  assert.match(skills, /assets\.tarkov\.dev\/skill-.*unoptimized/);
});

test("image remote pattern accepts a query string so upstream cache-busters do not 400", async () => {
  // Проверяем семантику через сам матчер Next, а не текст конфига: `search` в
  // RemotePattern сравнивается с `url.search` на ТОЧНОЕ равенство, поэтому
  // `search: ""` оставлял бы оптимизатору только ссылки без query. Ассет с
  // cache-buster — это 400 на /_next/image, а иконка в UI просто исчезает.
  const require = createRequire(import.meta.url);
  const { matchRemotePattern } = require("next/dist/shared/lib/match-remote-pattern.js");
  const { default: nextConfig } = await import("../next.config.ts");
  const [pattern] = nextConfig.images.remotePatterns;

  for (const asset of [
    "https://assets.tarkov.dev/achievement-6512ea46f7a078264a4376e4-icon.webp",
    "https://assets.tarkov.dev/achievement-6512ea46f7a078264a4376e4-icon.webp?v=2",
  ]) {
    assert.equal(
      matchRemotePattern(pattern, new URL(asset)),
      true,
      `remote pattern must accept ${asset}`,
    );
  }
  // Нестандартный порт и чужой хост по-прежнему отвергаются.
  assert.equal(matchRemotePattern(pattern, new URL("https://assets.tarkov.dev:8443/a.webp")), false);
  assert.equal(matchRemotePattern(pattern, new URL("https://example.invalid/a.webp")), false);
});

test("profile mode switch stays below profile actions and is available before profile data", async () => {
  const route = await readFile("app/player/[[...segments]]/page.tsx", "utf8");
  const modes = await readFile("components/ProfileModeSwitch.tsx", "utf8");
  const shell = await readFile("components/ProfileShell.tsx", "utf8");
  const header = await readFile("components/ProfileHeader.tsx", "utf8");
  const styles = await readFile("app/globals.css", "utf8");

  assert.doesNotMatch(route, /profile-route-modebar|const modeSwitch/);
  const pageBody = route.slice(route.indexOf("export default async function"));
  assert.doesNotMatch(pageBody, /await getPlayerLevels/);
  assert.match(shell, /profile-header__actions[\s\S]*profile-header__mode[\s\S]*<ProfileModeSwitch/);
  assert.match(header, /profile-header__actions[\s\S]*profile-header__mode[\s\S]*<ProfileModeSwitch/);
  assert.match(shell, /seasonalCycleId=\{mode === "seasonal" \? cycleId : undefined\}/);
  assert.match(header, /seasonalCycleId=\{seasonalCycleId\}/);
  assert.match(modes, /const activeSeasonalCycleId = seasonalCycleForNavigation\(current, seasonalCycleId, null, null\)/);
  assert.match(modes, /if \(activeSeasonalCycleId\) latestSeasonalCycleId = activeSeasonalCycleId/);
  assert.match(modes, /if \(mode === "seasonal"\) \{\s*params\.delete\("cycle"\)/);
  assert.match(modes, /seasonalCycleForNavigation\([\s\S]*latestSeasonalCycleId,[\s\S]*searchParams\.get\("cycle"\)/);
  assert.doesNotMatch(shell, /seasonalCycleId=\{cycleId\}/);
  assert.match(shell, /ProfileShellLoading[\s\S]*<ProfileModeSwitch current=\{mode\}/);
  assert.match(modes, /prefetch/);
  assert.match(modes, /scroll=\{false\}/);
  assert.match(modes, /aria-current=\{mode === current \? "page" : undefined\}/);
  assert.match(modes, /aria-busy=\{pending \|\| undefined\}/);
  assert.match(modes, /const pathname = usePathname\(\)/);
  assert.match(modes, /pendingNavigation\.fromMode === current &&[\s\S]*pendingNavigation\.pathname === pathname/);
  assert.match(modes, /window\.setTimeout\(\(\) => setPendingNavigation\(null\), PENDING_TIMEOUT_MS\)/);
  assert.match(modes, /onNavigate=\{\(\) => \{[\s\S]*warmProfile\(mode\)[\s\S]*window\.dispatchEvent\(new Event\("profile-mode-navigate"\)\)/);
  assert.match(modes, /warmPlayerProfileResponse\(`\/api\/player\/profile\?\$\{params\}`(?:,\s*controller\.signal)?\)/);
  assert.doesNotMatch(modes, /event\.preventDefault\(\)[\s\S]*router\.push\(target/);
  assert.equal((modes.match(/profile-mode-navigate/g) ?? []).length, 1);
  assert.match(styles, /\.profile-header__mode \.mode-switch/);
  assert.doesNotMatch(styles, /\.profile-route-modebar/);
});

test("profile mode switching is available during loading and capture is post-response", async () => {
  const regular = await readFile("components/RegularPlayer.tsx", "utf8");
  const seasonal = await readFile("components/SeasonalPlayer.tsx", "utf8");
  const radar = await readFile("components/PlayerRadarComparison.tsx", "utf8");
  const backfill = await readFile("scripts/backfill-admin-risk.mjs", "utf8");
  const route = await readFile("app/api/player/profile/route.ts", "utf8");

  assert.match(regular, /const forceRefresh = isReload\(\)/);
  assert.match(regular, /getCachedPlayerProfileResponse<RegularProfileResponse>\(profileRequestUrl\)/);
  assert.match(regular, /loadPlayerProfileResponse<RegularProfileResponse>/);
  assert.match(regular, /const \[loading, setLoading\] = useState\(!initialResponse\?\.stats\)/);
  assert.match(seasonal, /getCachedPlayerProfileResponse<SeasonalProfileResponse>\(profileRequestUrl\)/);
  assert.match(seasonal, /loadPlayerProfileResponse<SeasonalProfileResponse>\(profileRequestUrl\)/);
  assert.match(seasonal, /const \[loading, setLoading\] = useState\(!initialProfile\)/);
  const initialSeasonalLoad = sliceDeclaration(
    seasonal,
    "loadPlayerProfileResponse<SeasonalProfileResponse>",
    ".then((nextProfile)",
  );
  assert.doesNotMatch(regular, /(?:res|response)\.json\(\)/);
  assert.doesNotMatch(initialSeasonalLoad, /(?:res|response)\.json\(\)/);
  assert.doesNotMatch(seasonal, /new AbortController\(\)/);
  assert.match(regular, /forceRefresh=\{forceProgressionRefresh\}/);
  const progression = await readFile("components/ProgressionPanel.tsx", "utf8");
  assert.match(progression, /cache: forceRefresh \|\| refreshRevision > 0 \? "no-store" : "default"/);
  assert.match(progression, /const timelineCache = new Map<string, ProgressionTimelineResponse>\(\)/);
  assert.match(progression, /`\$\{mode\}\\0\$\{cycleId\}\\0\$\{aid\}`/);
  assert.match(progression, /const cached = timelineCache\.get\(cacheKey\) \?\? null/);
  assert.match(progression, /setData\(cached\)[\s\S]*void loadTimeline\(\)/);
  assert.match(progression, /startTransition\(\(\) => \{\s*setData\(result\)/);
  assert.match(progression, /window\.addEventListener\("profile-mode-navigate", abortForNavigation/);
  assert.match(progression, /data\?\.comparison\.status === "warming"/);
  assert.match(regular, /if \(loading\) \{\s*return <ProfileShellLoading mode=\{mode\} aid=\{Number\(aid\)\}/);
  assert.match(route, /"Cache-Control": "public, max-age=60, stale-while-revalidate=300"/);
  assert.ok((route.match(/\{ headers: profileHeaders \}/g) ?? []).length >= 2);
  assert.match(route, /const regularSnapshot = makePlayerSnapshot/);
  assert.match(route, /after\(\(\) => persistRegularProfileSnapshot\(regularSnapshot, \{ upsertPlayer: !\(fromCache \|\| fromEdgeCache\) \}\)/);
  const regularRoute = sliceDeclaration(
    route,
    "    const regularSnapshot = makePlayerSnapshot",
    "  } catch {",
  );
  assert.doesNotMatch(regularRoute, /await persistRegularProfileSnapshot/);
  const pveBranch = route.slice(route.indexOf('if (mode === "pve") {'));
  assert.match(pveBranch, /after\(\(\) => persistRegularProfileSnapshot\(pveSnapshot, \{/);
  assert.match(pveBranch, /mode: "pve"/);
  assert.match(pveBranch, /pve profile capture after response failed/);
  assert.match(pveBranch, /\{ inserted: false, status: "queued" \}/);
  assert.doesNotMatch(pveBranch, /await persistRegularProfileSnapshot\(pveSnapshot/);
  assert.match(route, /const riskIsFresh = storedRisk &&[\s\S]*Date\.now\(\) - storedRisk\.evaluatedAt < 5 \* 60 \* 60 \* 1000/);
  assert.match(route, /after\(async \(\) => \{[\s\S]*setTimeout\(resolve, 1_000\)[\s\S]*await evaluateAndStoreRisk/);
  assert.match(route, /const currentStoredRisk = seasonalRiskMatchesIdentity\(storedRisk, \{ aid, cycleId \}\)[\s\S]*seasonalRiskIsCurrent = result\.ok && currentStoredRisk !== null/);
  assert.match(route, /const seasonalRiskIsFresh = seasonalRiskIsCurrent && currentStoredRisk !== null &&[\s\S]*currentStoredRisk\.scoreVersion === riskScoreVersion\("seasonal", cycleId\)[\s\S]*currentStoredRisk\.profileUpdatedAt >= result\.profile\.profileUpdatedAt[\s\S]*Date\.now\(\) - currentStoredRisk\.evaluatedAt < 5 \* 60 \* 60 \* 1000/);
  assert.match(route, /const publicRisk = seasonalRiskIsCurrent && currentStoredRisk !== null &&[\s\S]*currentStoredRisk\.scoreVersion === riskScoreVersion\("seasonal", cycleId\)/);
  assert.match(route, /const publicRisk = storedRisk\?\.scoreVersion === riskScoreVersion\("pve", cycleId\)/);
  assert.match(route, /const publicRisk = storedRisk\?\.scoreVersion === riskScoreVersion\("regular", cycleId\)/);
  assert.match(route, /const publicRiskView = storedRisk\?\.scoreVersion === riskScoreVersion\("regular", cycleId\)/);
  assert.match(route, /risk = null;\s*scheduleArenaRiskRefresh\(\)/);
  assert.match(radar, /strategy: input\.strategy === "population" \? "population" : "matched"/);
  assert.match(radar, /comparisonCohortMetricValue\(cohort\.strategy, average \?\? \{ value: null, count: 0 \}\)/);
  assert.match(backfill, /scoreVersion: riskScoreVersion\(mode, cycleId\)/);
  assert.match(backfill, /scoreVersion: riskScoreVersion\("seasonal", cycleId\)/);
  assert.match(route, /if \(result\.ok && !seasonalRiskIsFresh\) \{[\s\S]*after\(async \(\) => \{[\s\S]*setTimeout\(resolve, 1_000\)[\s\S]*await evaluateAndStoreSeasonalRisk/);
  assert.ok(route.indexOf("const storedRisk = result.ok") < route.indexOf("if (result.ok && !seasonalRiskIsFresh)"));
  assert.match(route, /const \[baseline, metadata, masteryReferences\] = await Promise\.all\(\[[\s\S]*getAchievements\("seasonal"\)\.catch/);
  assert.doesNotMatch(route, /getCachedAchievements\("seasonal"\)/);
  assert.match(route, /metadata\.get\(achievement\.id\)/);
  assert.match(route, /buildWeaponMasteryRows\(viewModel\.mastering\.items, masteryReferences\)/);
  assert.match(seasonal, /masteryFromViewModel/);
  assert.match(seasonal, /<ProfileMastering items=\{masteryItems\}/);
});

test("profile navigation exposes the shell immediately and overlaps regular API work", async () => {
  const loading = await readFile("app/player/loading.tsx", "utf8");
  const search = await readFile("components/SearchBar.tsx", "utf8");

  assert.match(loading, /usePathname/);
  assert.match(loading, /useSearchParams/);
  assert.match(loading, /parsePlayerId/);
  assert.match(loading, /<RegularPlayer[\s\S]*aid=\{String\(aid\)\}/);
  assert.match(loading, /<SeasonalPlayer[\s\S]*cycleId=\{cycleId\}/);
  assert.match(loading, /levelBands=\{cumulativeLevelBands\(PLAYER_LEVELS_V2026_07_22\)\}/);
  assert.match(loading, /<ProfileShellLoading mode=\{mode\} aid=\{aid\} \/>/);
  assert.match(search, /const profileParams = new URLSearchParams\(\{ aid: String\(player\.aid\), mode: selectedMode \}\)/);
  assert.match(search, /warmPlayerProfileResponse\(`\/api\/player\/profile\?\$\{profileParams\}`\)/);
  assert.match(search, /selectedMode === "regular" \|\| selectedMode === "pve"/);
  assert.match(search, /const timelineParams = new URLSearchParams\(\{ mode: selectedMode, cycle: "persistent", aid: String\(player\.aid\) \}\)/);
  assert.match(search, /fetch\(`\/api\/progression\/timeline\?\$\{timelineParams\}`, \{ cache: "default" \}\)/);
  assert.match(search, /router\.push\(href\)/);
});

test("search keeps its mode picker inline and dismisses the animated history outside", async () => {
  const search = await readFile("components/SearchBar.tsx", "utf8");
  const styles = await readFile("app/globals.css", "utf8");

  assert.match(search, /className="search-unit__field"[\s\S]*className="search-unit__mode-trigger"/);
  assert.match(search, /aria-haspopup="listbox"[\s\S]*data-open=\{modeMenuOpen\}/);
  assert.doesNotMatch(search, /aria-pressed=\{searchMode === mode\}/);
  assert.match(search, /document\.addEventListener\("pointerdown", closeOutside, true\)/);
  assert.match(search, /document\.addEventListener\("focusin", closeOutside, true\)/);
  assert.match(search, /className="search-unit__history"[\s\S]*data-open=\{showRecent\}[\s\S]*inert=\{!showRecent\}/);
  assert.match(search, /player\.profiles\.map[\s\S]*search-unit__result-mode[\s\S]*search-unit__result-id/);
  assert.match(styles, /\.search-unit__history \{[^}]*position: absolute/s);
  assert.match(styles, /\.search-unit__mode-menu,[\s\S]*transform: translateY\(-8px\)/);
  assert.match(styles, /prefers-reduced-motion: reduce[\s\S]*\.search-unit__history/);
});

test("visitor help is hidden from home without deleting its implementation", async () => {
  const home = await readFile("components/HomePage.tsx", "utf8");
  assert.doesNotMatch(home, /CommunityHelper/);
  await access("components/CommunityHelper.tsx");
  await access("app/api/community/ban-reviews/claim/route.ts");
});

test("ban review request results are dropped after unmount", async () => {
  const review = await readFile("components/CommunityBanReview.tsx", "utf8");

  assert.match(review, /const mounted = useRef\(true\);/);
  assert.match(review, /useEffect\(\(\) => \{\s*mounted\.current = true;\s*return \(\) => \{ mounted\.current = false; \};\s*\}, \[\]\);/);
  for (const [setter, expected] of [["setCandidates", 2], ["setError", 3], ["setLoading", 1], ["setVoting", 1]]) {
    assert.equal(
      (review.match(new RegExp(`if \\(mounted\\.current\\) ${setter}\\(`, "g")) ?? []).length,
      expected,
      `${setter} must be guarded after each await`,
    );
  }
});

test("a successful ban-review claim clears the stale load error", async () => {
  const review = await readFile("components/CommunityBanReview.tsx", "utf8");

  // `claim` is keyed on `t`, so the header EN/RU toggle re-claims the queue.
  // A claim that failed once must clear its own banner once a later one
  // succeeds, otherwise the alert stacks on the list it just loaded -- and
  // with an empty queue there is no vote left to clear it.
  const claim = review.slice(
    review.indexOf("const claim = useCallback"),
    review.indexOf("useEffect(() => { void claim(); }, [claim]);"),
  );
  assert.match(claim, /setCandidates\(body\.candidates \?\? \[\]\);[\s\S]{0,200}if \(mounted\.current\) setError\(""\);/);
  // The clear waits for the response, guarded like every other post-await
  // setter. Hoisting it into the preamble (where `vote` can put its clear,
  // because it runs before its await) would blank a claim still in flight.
  assert.doesNotMatch(claim.slice(0, claim.indexOf("await fetch(")), /setError\(""\)/);
});

test("community helper drops poll and request results after unmount", async () => {
  const helper = await readFile("components/CommunityHelper.tsx", "utf8");

  assert.match(helper, /const mounted = useRef\(true\);/);
  assert.match(helper, /useEffect\(\(\) => \{\s*mounted\.current = true;\s*return \(\) => \{ mounted\.current = false; \};\s*\}, \[\]\);/);
  for (const [setter, expected] of [["setStatus", 2], ["setError", 2], ["setStarting", 1], ["setChecking", 1]]) {
    assert.equal(
      (helper.match(new RegExp(`if \\(mounted\\.current\\) ${setter}\\(`, "g")) ?? []).length,
      expected,
      `${setter} must be guarded after each await`,
    );
  }
});

test("the FAQ dialog takes focus, traps Tab behind an inert page, and gives it back", async () => {
  const faq = await readFile("components/FaqWidget.tsx", "utf8");

  // Moving focus in is what keeps the keyboard off the trigger behind the backdrop,
  // and inverting the body siblings is what keeps Tab off the page as well. The
  // wrapper holds the overlay and the trigger as one body child, so the rest of the
  // page is exactly what is left over. The gaps are \s* only, so the match cannot
  // run out of this effect and into the Escape one; keyed on [open] so the cleanup
  // covers the button, backdrop and Escape close paths, and runs on unmount too. The
  // open also clears the flag the navigating closes leave behind.
  assert.match(
    faq,
    /useEffect\(\(\) => \{\s*if \(!open\) return;\s*navigatingRef\.current = false;\s*const siblings = Array\.from\(document\.body\.children\)\.filter\(\s*\(el\): el is HTMLElement => el instanceof HTMLElement && el !== rootRef\.current,\s*\);\s*for \(const el of siblings\) el\.inert = true;\s*dialogRef\.current\?\.focus\(\);\s*return \(\) => \{\s*for \(const el of siblings\) el\.inert = false;\s*\};\s*\}, \[open\]\);/,
  );
  assert.match(faq, /<div ref=\{rootRef\}>/);
  assert.doesNotMatch(faq, /return \(\) => \{ triggerRef\.current\?\.focus\(\); \};/);
  // The gaps are the dialog's own attributes, so the match cannot slide onto the
  // trigger: a dialog without `tabIndex={-1}` cannot take focus at all, and the focus
  // call in the effect would no-op on it. Inerting the page is also what makes
  // `aria-modal` honest, rather than a claim about a background still tabbable.
  assert.match(
    faq,
    /<div\s+ref=\{dialogRef\}\s+role="dialog"\s+aria-modal="true"\s+aria-label=\{t\("faq\.title"\)\}\s+tabIndex=\{-1\}/,
  );
  assert.match(faq, /<button\s+ref=\{triggerRef\}/);
  // Focus returns from the backdrop's animation end, not from the open -> closing
  // step, because the backdrop keeps covering the trigger until that fires. The three
  // answer links close the dialog and soft-navigate, and the widget is in the root
  // layout, so that end can land on the destination page: the flag keeps the router's
  // own focus handling in charge there.
  assert.match(
    faq,
    /onAnimationEnd=\{\(event\) => \{\s*if \(event\.target === event\.currentTarget && dialogState === "closing"\) \{\s*setDialogState\("closed"\);\s*if \(!navigatingRef\.current\) triggerRef\.current\?\.focus\(\);\s*\}\s*\}\}/,
  );
  assert.match(faq, /function closeFaqAndNavigate\(\) \{\s*navigatingRef\.current = true;\s*closeFaq\(\);\s*\}/);
  assert.equal((faq.match(/onClick=\{closeFaqAndNavigate\}/g) ?? []).length, 3);
});

test("average statistic switch keeps URL state and masks stale portrait values", async () => {
  const source = await readFile("app/average/page.tsx", "utf8");
  const header = await readFile("components/AveragePageHeader.tsx", "utf8");
  const styles = await readFile("app/globals.css", "utf8");
  const segmented = await readFile("components/SegmentedRadio.tsx", "utf8");

  assert.match(source, /searchParams\.get\("statistic"\) === "median"/);
  assert.match(source, /new URLSearchParams\(searchParams\.toString\(\)\)/);
  assert.match(source, /params\.delete\("statistic"\)/);
  assert.match(source, /router\.replace\([\s\S]*?\{ scroll: false \}\)/);
  assert.match(source, /new URLSearchParams\(\{ dimension, metric: yMetric, mode, statistic, period \}\)/);
  assert.match(source, /\.then\(\(json\) => \{\s*if \(controller\.signal\.aborted\) return;\s*setData\(json\)/);
  assert.match(source, /data\?\.statistic === statistic &&[\s\S]*?data\.period === period &&[\s\S]*?data\.dimension === dimension &&[\s\S]*?data\.metric === yMetric/);
  assert.match(source, /const terminalError = Boolean\(error\) && !loading && currentData === null/);
  assert.match(source, /\{terminalError \? null : !currentData \? \(/);
  assert.match(source, /\{!terminalError && \(\s*<div ref=\{chartRef\}/);
  assert.match(header, /name="average-statistic"/);
  assert.match(header, /average-settings__top[\s\S]*average-settings__groups[\s\S]*average-settings__mode/);
  assert.match(styles, /\.average-settings__top \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(340px, 520px\)/);
  assert.match(segmented, /<fieldset className=\{`segmented-control/);
  assert.match(segmented, /type="radio"/);
  assert.match(segmented, /checked=\{value === option\.value\}/);
});

test("active navigation links go back only for an unmodified click at their destination", async () => {
  const { activeLinkAction } = await import("../lib/active-link.ts");
  const helper = await readFile("lib/active-link.ts", "utf8");
  const header = await readFile("components/SiteHeader.tsx", "utf8");
  const average = await readFile("components/AverageNavButton.tsx", "utf8");
  const averagePage = await readFile("app/average/page.tsx", "utf8");
  const modes = await readFile("components/ProfileModeSwitch.tsx", "utf8");
  const seasonalAverage = await readFile("components/SeasonalAverage.tsx", "utf8");

  const primary = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
  };
  assert.equal(activeLinkAction(primary, true, 2), "back");
  assert.equal(activeLinkAction(primary, true, 1), "fallback");
  assert.equal(activeLinkAction(primary, false, 2), null);
  for (const modifier of ["metaKey", "ctrlKey", "shiftKey", "altKey"]) {
    assert.equal(activeLinkAction({ ...primary, [modifier]: true }, true, 2), null);
  }
  assert.equal(activeLinkAction({ ...primary, button: 1 }, true, 2), null);

  assert.match(helper, /event\.button !== 0/);
  assert.doesNotMatch(helper, /document\.referrer/);
  assert.match(helper, /activeLinkAction\(event, atDestination, window\.history\.length\)/);
  assert.match(helper, /router\.back\(\)/);
  assert.match(helper, /router\.replace\(fallback\)/);
  assert.match(header, /handleActiveLinkClick\(event, pathname === item\.href, router\)/);
  assert.match(average, /const active = pathname\.startsWith\("\/average"\)/);
  assert.match(average, /handleActiveLinkClick\(event, active, router\)/);
  assert.match(modes, /onNavigate=\{\(\) => \{/);
  assert.match(modes, /prefetch/);
  assert.match(modes, /onBeforeNavigate\?\.\(mode\)/);
  assert.match(averagePage, /averageRequestRef\.current\?\.abort\(\)/);
  assert.match(averagePage, /onBeforeNavigate=\{cancelAverageRequests\}/);
  assert.match(averagePage, /progressionRequestRef\.current\?\.abort\(\)/);
  assert.match(averagePage, /requestRef=\{progressionRequestRef\}/);
  assert.match(modes, /handleActiveLinkClick\(event, mode === current, router\)/);
  assert.match(modes, /aria-current=\{mode === current \? "page" : undefined\}/);
  assert.match(seasonalAverage, /average-settings__top[\s\S]*average-settings__mode md:col-start-2/);
});

test("regular average period switch keeps URL state and masks stale responses", async () => {
  const source = await readFile("app/average/page.tsx", "utf8");
  const header = await readFile("components/AveragePageHeader.tsx", "utf8");

  assert.match(source, /mode === "regular" && searchParams\.get\("period"\) === "90d"/);
  assert.match(source, /data\?\.mode === mode &&/);
  assert.match(source, /mode !== "seasonal" \|\| data\.cycleId === cycleId/);
  assert.match(source, /const \[selectedPeriod, setSelectedPeriod\] = useState<AveragePeriod>\(urlPeriod\)/);
  assert.match(source, /params\.set\("period", next\)/);
  assert.match(source, /params\.delete\("period"\)/);
  assert.match(source, /setSelectedPeriod\(next\);\s*setSelection\(null\);\s*setRequestedRange\(null\);\s*setData\(null\);/);
  assert.match(source, /new URLSearchParams\(\{ dimension, metric: yMetric, mode, statistic, period \}\)/);
  assert.doesNotMatch(source, /setSelection\(\(current\)/);
  assert.match(source, /data\?\.statistic === statistic &&[\s\S]*?data\.period === period/);
  assert.match(source, /mode === "regular" && \(/);
  assert.match(header, /name="average-period"/);
});

test("radar statistic switch identifies requests by method", async () => {
  const source = await readFile("components/PlayerRadarComparison.tsx", "utf8");

  assert.match(source, /searchParams\.get\("statistic"\) === "median"/);
  assert.match(source, /statistic,\s*period,\s*\}\);/);
  assert.match(source, /const cohortRequestId = `\$\{aid\}:\$\{mode\}:\$\{cycleId\}:\$\{hoursCenter\}:\$\{raidsCenter\}:/);
  assert.match(source, /requestId: `\$\{sourceAid\}:\$\{mode\}:\$\{cycleId\}:\$\{hoursCenter\}:\$\{raidsCenter\}:/);
  assert.match(source, /payload\.requestId === cohortRequestId/);
  assert.match(source, /favoriteProfile\?\.requestId === favoriteRequestId \? favoriteProfile\.stats : null/);
  assert.match(source, /params\.delete\("statistic"\)/);
  assert.match(source, /router\.replace\([\s\S]*?\{ scroll: false \}\)/);
  assert.match(source, /select value=\{statistic\} onChange=/);
});

test("regular radar period switch identifies requests by freshness", async () => {
  const source = await readFile("components/PlayerRadarComparison.tsx", "utf8");

  assert.match(source, /mode === "regular" && searchParams\.get\("period"\) === "90d"/);
  assert.match(source, /const \[selectedPeriod, setSelectedPeriod\] = useState<AveragePeriod>\(urlPeriod\)/);
  assert.match(source, /setSelectedPeriod\(next\)/);
  assert.match(source, /if \(!controller\.signal\.aborted && payload\.requestId === cohortRequestId\) setRemoteCohort\(payload\)/);
  assert.match(source, /period,\s*\}\);/);
  assert.match(source, /requestId: `\$\{sourceAid\}:\$\{mode\}:\$\{cycleId\}:\$\{hoursCenter\}:\$\{raidsCenter\}:\$\{input\.statistic \?\? statistic\}:\$\{input\.period \?\? period\}`/);
  assert.match(source, /payload\.requestId === cohortRequestId/);
  assert.match(source, /params\.delete\("period"\)/);
  assert.match(source, /select value=\{period\} onChange=/);
});

test("radar keeps raw player values independent from baseline availability", async () => {
  const source = await readFile("components/PlayerRadarComparison.tsx", "utf8");
  const radar = await readFile("components/ProfileRadar.tsx", "utf8");
  assert.match(source, /finiteNonNegativeMetricValue\(metric\.get\(stats\)\)/);
  assert.match(source, /a: playerValues\?\.\[metric\.key\] \?\? null/);
  assert.match(source, /cohort\?\.quality === "sufficient" && cohort.twoDimensional/);
  assert.match(source, /comparisonCohortMetricValue\(cohort\.strategy, average \?\? \{ value: null, count: 0 \}\)/);
  assert.match(radar, /value\(metric.a, metric\)/);
  assert.match(radar, /points.every\(\(p\) => p != null\)/);
  assert.match(radar, /homePercentageDifference\(metric.a, metric.b\)/);
  assert.match(radar, /radar.baselineUnavailable/);
});

test("profile refresh checks automatically after returning without requiring F5", async () => {
  const button = await readFile("components/RefreshButton.tsx", "utf8");
  const profile = await readFile("components/RegularPlayer.tsx", "utf8");

  // Returning from tarkov.dev still checks without an F5, but the trigger is page
  // visibility: a background tab never hides this one, so a ctrl/cmd or middle click
  // must not leave a pending flag that fires on the next unrelated focus.
  assert.match(button, /document\.addEventListener\("visibilitychange", handleVisible\)/);
  assert.match(button, /document\.visibilityState !== "visible" \|\| !awaitingReturn\.current/);
  assert.match(button, /event\.button !== 0 \|\| event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey \|\| event\.altKey/);
  assert.match(button, /awaitingReturn\.current = true/);
  assert.doesNotMatch(button, /window\.addEventListener\("focus"/);
  assert.match(button, /if \(!onCheck\) return/);
  assert.match(button, /if \(!onCheck \|\| checking\.current\) return/);
  assert.match(button, /player\.refreshCheckAgain/);
  assert.match(button, /onCheck && status !== "idle"/);
  assert.match(button, /aria-live="polite"/);
  // The button's own check carries wait=1: it must return the real post-refresh
  // profile, because its result decides «Данные профиля обновлены» vs
  // «Новых данных пока нет».
  assert.match(profile, /new URLSearchParams\(\{ aid, mode, refresh: "1", wait: "1" \}\)/);
  assert.match(profile, /setStats\(data\.stats\)/);
  assert.match(profile, /JSON\.stringify\(data\.stats\) !== JSON\.stringify\(previousStats\)/);
  assert.match(profile, /requestGeneration\.current \+= 1/);
  assert.match(profile, /if \(generation !== requestGeneration\.current\) return "unchanged"/);
  assert.match(profile, /if \(refreshPromise\.current === request\) refreshPromise\.current = null/);
  assert.ok((profile.match(/key=\{`\$\{aid\}:\$\{mode\}`\}/g) ?? []).length >= 2);
  assert.ok((profile.match(/player\.profileUpdated/g) ?? []).length >= 1);
});

test("Seasonal missing profiles keep the shell and refresh after returning", async () => {
  const seasonal = await readFile("components/SeasonalPlayer.tsx", "utf8");
  const shell = await readFile("components/ProfileShell.tsx", "utf8");
  const dictionary = await readFile("lib/i18n/dictionary.ts", "utf8");

  assert.match(seasonal, /body\.code === "mode_profile_unavailable"/);
  assert.match(seasonal, /const unknownValue = t\("common\.unknown"\)/);
  assert.match(seasonal, /overviewCards=\{overviewLabels\.map\(\(label\) => \(\{ label, value: unknownValue \}\)\)\}/);
  assert.match(shell, /Array\.from\(\{ length: 4 \}\)/);
  assert.match(seasonal, /<SeasonalProfileActions[\s\S]*?missing[\s\S]*?onCheck=\{refreshProfile\}/);
  assert.match(seasonal, /refresh: "1"/);
  assert.match(seasonal, /<ProfileActivity[\s\S]*updatedAt=\{profile.profileUpdatedAt\}/);
  assert.match(seasonal, /setProgressionRefreshRevision\(\(current\) => current \+ 1\)/);
  assert.match(dictionary, /"player\.refreshStaleHint": "This profile was last updated more than three days ago\./);
  assert.match(dictionary, /"player\.refreshStaleHint": "Профиль не обновлялся больше трёх дней\./);
});

test("seasonal PMC K/D fallback uses PMC-vs-PMC kills", async () => {
  const seasonal = await readFile("components/SeasonalPlayer.tsx", "utf8");

  assert.match(
    seasonal,
    /const pmcKdRatio = existing\?\.pmcKdRatio \?\? \(counters\.pmcDeaths > 0 \? counters\.killedPmc \/ counters\.pmcDeaths : null\);/,
  );
});

test("profile freshness becomes stale only after three full days", async () => {
  const { PROFILE_STALE_MS, isProfileStale } = await import("../lib/profile-refresh-policy.ts");
  const now = 1_800_000_000_000;

  assert.equal(PROFILE_STALE_MS, 3 * 24 * 60 * 60 * 1000);
  assert.equal(isProfileStale(now - PROFILE_STALE_MS + 1, now), false);
  assert.equal(isProfileStale(now - PROFILE_STALE_MS, now), true);
  assert.equal(isProfileStale(now - PROFILE_STALE_MS - 1, now), true);
  assert.equal(isProfileStale(null, now), false);
});

test("profile skills reject unknown counters and preserve level boundaries", async () => {
  const { normalizeProfileSkill } = await import("../lib/profile-skills.ts");
  for (const value of [null, {}, { Id: "BotReload", Progress: 300 }, { Id: "Strength", Progress: true }, { Id: "Strength", Progress: -1 }, { Id: "Strength", Progress: Infinity }]) {
    assert.equal(normalizeProfileSkill(value), null);
  }
  assert.deepEqual(normalizeProfileSkill({ Id: "Strength", Progress: 5075.5 }), { id: "Strength", progress: 5075.5, level: 50, percent: 75.5, elite: false });
  assert.deepEqual(normalizeProfileSkill({ id: "Strength", progress: 5200 }), { id: "Strength", progress: 5200, level: 51, percent: 100, elite: true });
});

test("profile history preserves reset boundaries and gaps, and deduplicates date labels", async () => {
  const { profileProgressionSegments, profileProgressionTime, profileChartTicks } = await import("../lib/profile-progression.ts");
  const points = [
    { seriesId: "old", pmcRaids: 100, value: 3, level: 20 },
    { seriesId: "new", pmcRaids: 1, value: 2, level: 1 },
    { seriesId: "new", pmcRaids: 2, value: NaN, level: null },
    { seriesId: "new", pmcRaids: 3, value: 4, level: 2 },
  ];
  assert.deepEqual(profileProgressionSegments(points, "kd", true).map((s) => s.map((p) => p.value)), [[3], [2], [4]]);
  assert.deepEqual(profileProgressionSegments(points, "level", false).map((s) => s.map((p) => p.value)), [[1], [2]]);
  assert.equal(profileProgressionTime({ date: "2026-09-01" }), Date.parse("2026-09-01T00:00:00+03:00"));
  assert.equal(profileProgressionTime({ date: "invalid" }), null);
  assert.equal(profileProgressionTime({ observedAt: 1234, date: "invalid" }), 1234);
  assert.deepEqual(profileChartTicks([1, 1, 1.1, 2, Infinity], (n) => n.toFixed(0)), [{ value: 1, label: "1" }, { value: 2, label: "2" }]);
});

test("unknown regular PvP stats are not rendered or scored as zero", async () => {
  const profile = await readFile("components/RegularPlayer.tsx", "utf8");
  const radar = await readFile("components/PlayerRadarComparison.tsx", "utf8");
  const score = await readFile("components/CheaterScore.tsx", "utf8");

  assert.match(profile, /const pvpStatsKnown = stats\.pvpStatsKnown !== false/);
  assert.match(profile, /pvpStatsKnown \? stats\.pmcKdRatio : t\("common\.notAvailable"\)/);
  assert.match(profile, /pvpStatsKnown \? stats\.killedPmc\.toLocaleString\(\) : t\("common\.notAvailable"\)/);
  // The overview card is the one place a placeholder is shown next to a unit, so
  // the "%" has to be part of the same guard: an unconditional suffix rendered
  // "Н/Д%" / "N/A%", i.e. a percentage on a value that does not exist.
  assert.match(
    profile,
    /\{ label: t\("player\.survivalRate"\), value: pvpStatsKnown \? stats\.pmcSurvivalRate : t\("common\.notAvailable"\), suffix: pvpStatsKnown \? "%" : undefined \}/,
  );
  assert.doesNotMatch(
    profile,
    /pvpStatsKnown \? stats\.pmcSurvivalRate : t\("common\.notAvailable"\), suffix: "%"/,
  );
  // The fix belongs to the card, not to the shared shell: it renders whatever
  // suffix the caller passes, so the caller has to withhold it.
  const shell = await readFile("components/ProfileShell.tsx", "utf8");
  assert.match(shell, /\{item\.value\}\{item\.suffix && <span>\{item\.suffix\}<\/span>\}/);
  assert.doesNotMatch(shell, /common\.notAvailable/);
  assert.match(radar, /playerValues = demo[\s\S]*?playerStatsKnown \? valuesFromStats\(stats\) : null/);
  assert.match(radar, /favoriteStats && favoriteStatsKnown/);
  assert.match(radar, /radar\.incompletePvp\.player/);
  assert.match(radar, /radar\.incompletePvp\.favorite/);
  assert.match(score, /statsKnown === false/);
  assert.match(score, /cheater\.incompletePvp/);
});

test("an unknown seasonal PMC survival rate is never rendered as a percentage", async () => {
  const seasonal = await readFile("components/SeasonalPlayer.tsx", "utf8");
  const shell = await readFile("components/ProfileShell.tsx", "utf8");
  const card = await readFile("components/StatCard.tsx", "utf8");
  const dictionary = await readFile("lib/i18n/dictionary.ts", "utf8");

  // The seasonal placeholder is `?` in both languages, so the defect reads `?%`
  // either way. The sibling regular fix guards a different key, `common.notAvailable`.
  assert.match(dictionary, /"common\.unknown": "\?"/);
  assert.equal((dictionary.match(/"common\.unknown": "\?"/g) ?? []).length, 2);

  // The general rule: a value built from `displayNumber(..., unknownValue)` may be the
  // placeholder, so it must not also carry a literal suffix. Asserted over every such
  // card in the file rather than on one line, so a new one cannot reintroduce it.
  const placeholderCards = seasonal.split("\n").filter((line) => line.includes("displayNumber(") && line.includes("unknownValue)"));
  assert.ok(placeholderCards.length >= 2, `expected the seasonal placeholder cards, found ${placeholderCards.length}`);
  for (const line of placeholderCards) {
    assert.doesNotMatch(line, /suffix(:|=)"/, `a placeholder value must not carry a literal suffix: ${line.trim()}`);
  }

  // Two cards, two label keys, one shared value; both gate the suffix on the same
  // expression `displayNumber` receives, so the guard cannot drift from the fallback.
  assert.match(seasonal, /label: t\("seasonal\.pmcSurvival"\), value: displayNumber\(stats\.pmcSurvivalRate, 1, unknownValue\), suffix: stats\.pmcSurvivalRate == null \? undefined : "%"/);
  assert.match(seasonal, /label=\{t\("seasonal\.metric\.survival"\)\} value=\{displayNumber\(stats\.pmcSurvivalRate, 1, unknownValue\)\} suffix=\{stats\.pmcSurvivalRate == null \? undefined : "%"\}/);
  assert.equal(placeholderCards.filter((line) => /suffix[:=]/.test(line)).length, 2, "the two survival cards are the only suffixed placeholder cards");

  // Both renderers stay generic: each prints what the caller supplies, and neither
  // learns what one dictionary value means.
  assert.match(shell, /\{item\.value\}\{item\.suffix && <span>\{item\.suffix\}<\/span>\}/);
  assert.match(card, /\{suffix && <span className="metric-card__suffix ml-1">\{suffix\}<\/span>\}/);
  assert.doesNotMatch(`${shell}\n${card}`, /common\.unknown|unknownValue/);
});

test("regular PvP progression precedes the single risk card and radar", async () => {
  const profile = await readFile("components/RegularPlayer.tsx", "utf8");
  const panel = await readFile("components/ProgressionPanel.tsx", "utf8");
  const chart = await readFile("components/ProgressionTimelineChart.tsx", "utf8");
  const score = await readFile("components/CheaterScore.tsx", "utf8");
  const dictionary = await readFile("lib/i18n/dictionary.ts", "utf8");

  const progression = profile.indexOf("<ProgressionPanel");
  const cheatingRisk = profile.indexOf("<CheaterScore");
  const radar = profile.indexOf("<PlayerRadarComparison");
  assert.ok(progression > 0 && cheatingRisk > progression && radar > cheatingRisk);
  const shell = await readFile("components/ProfileShell.tsx", "utf8");
  assert.match(profile, /progression=\{<ProgressionPanel/);
  assert.match(profile, /risk=\{<div className="profile-risk">[\s\S]*<CheaterScore compact/);
  assert.match(shell, /id="progression"[\s\S]*?id="risk"[\s\S]*?id="comparison"[\s\S]*?id="statistics"[\s\S]*?id="skills"/);
  assert.doesNotMatch(score, /section-kicker">\{t\("cheater\.heading"\)\}/);
  assert.match(profile, /<ProgressionPanel[\s\S]*?mode=\{mode\}[\s\S]*?cycleId="persistent"/);
  assert.match(profile, /<ProgressionPanel[\s\S]*?profileUpdatedAt=\{profileUpdatedAt\}/);
  assert.match(profile, /refreshRevision=\{progressionRefreshRevision\}/);
  assert.match(profile, /setProgressionRefreshRevision\(\(current\) => current \+ 1\)/);
  assert.match(profile, /risk=\{serverRisk \?\? progressionRisk\}/);

  assert.match(panel, /fetch\(`\/api\/progression\/timeline\?\$\{params\}`/);
  for (const parameter of [
    "mode,",
    "cycle: cycleId",
    "aid: String(aid)",
  ]) {
    assert.ok(panel.includes(parameter), `missing progression parameter: ${parameter}`);
  }
  assert.doesNotMatch(panel, /dimension|center: String/);
  assert.match(panel, /ProgressionTimelineChart/);
  assert.match(panel, /ProgressionTimelineResponse/);
  assert.match(panel, /setData\(result\)/);
  assert.match(panel, /function timelineHasPoints/);
  assert.match(panel, /\[aid, cycleId, forceRefresh, mode, onRiskChange, profileUpdatedAt, refreshRevision\]/);
  assert.doesNotMatch(panel, /params\.(?:set|append)\("revision"/);
  assert.match(panel, /role="status"/);
  assert.match(panel, /history\.ready \? "progression\.ready" : "progression\.collecting"/);
  assert.match(panel, /result\.history\?\.ready && validRisk\(result\.risk\) \? result\.risk : null/);
  assert.match(panel, /if \(controller\.signal\.aborted\) return/);
  assert.match(panel, /useFavorites/);
  assert.match(panel, /favorites\.filter\(\(favorite\) => favorite\.aid !== aid\)/);
  assert.match(panel, /const \[selection, setSelection\] = useState<ComparisonSelection>/);
  assert.match(panel, /selection\.ownerKey === mainIdentityKey \? selection\.aid : ""/);
  assert.match(panel, /const cacheKey = `\$\{mode\}\\0\$\{cycleId\}\\0\$\{favorite\.aid\}`/);
  assert.match(panel, /new AbortController\(\)/);
  assert.match(panel, /secondaryGeneration/);
  assert.match(panel, /secondaryController\.current\?\.abort\(\)/);
  assert.match(panel, /generation !== secondaryGeneration\.current/);
  assert.match(panel, /const activeSecondary = selectedFavorite && secondaryCandidate && validTimelineResponse/);
  assert.match(panel, /onChange=\{\(event\) => selectComparison\(event\.target\.value\)\}/);
  assert.match(panel, /validTimelineResponse\(result, \{ aid: favorite\.aid, mode, cycleId \}\)/);
  assert.match(panel, /!response\.ok \|\| !validTimelineResponse\(result/);
  assert.match(panel, /timeline\.identity\.aid === expected\.aid/);
  assert.match(panel, /timeline\.identity\.mode === expected\.mode/);
  assert.match(panel, /timeline\.identity\.cycleId === expected\.cycleId/);
  assert.match(panel, /function timelineHasPlayerHistory/);
  assert.match(panel, /timeline\.metrics\.xp, timeline\.metrics\.pvp_kd, timeline\.metrics\.ai_kd, timeline\.metrics\.survival/);
  assert.match(panel, /progression\.compare\.(?:authRequired|noFavorites|noEligible|historyLoading|noHistory|error)/);
  assert.match(panel, /profile-select/);
  assert.match(panel, /role="status"/);
  assert.match(chart, /cumulativeLevelBands/);
  assert.match(chart, /clipPath/);
  assert.match(chart, /data-metric=\{value\}/);
  assert.match(chart, /aria-pressed=\{metric === value\}/);
  assert.match(chart, /profileProgressionSegments\(source, metric, allHistory\)/);
  assert.match(chart, /comparison\?\.timeline.metrics\[key\]\?\.player/);
  assert.match(chart, /profileProgressionSegments\(comparisonSource, metric, allHistory\)/);
  assert.match(chart, /data.identity.mode === "pve" \? "ai_kd" : "pvp_kd"/);
  assert.match(chart, /const showOverall = overall && axis === "raids" && average.length > 0/);
  assert.match(chart, /profileChartTicks/);
  assert.match(chart, /profileProgressionTime/);
  assert.match(chart, /role="status"/);
  assert.match(chart, /onPointerMove/);
  assert.match(chart, /onFocus/);
  assert.match(chart, /event.key === "Escape"/);
  assert.match(chart, /ChartCrosshair/);
  assert.doesNotMatch(chart, /profile-chart-tooltip/);
  assert.doesNotMatch(chart, /<title>/);
  assert.match(dictionary, /"progression\.series\.overall": "Median PvP player"/);
  assert.match(dictionary, /"progression\.series\.overall": "Медианный игрок PvP"/);
  assert.match(dictionary, /"progression\.pointTipRange":/);
  assert.match(dictionary, /"progression\.timeline\.metric\.aiKd": "PvE K\/D"/);
  assert.match(dictionary, /"progression\.timeline\.tooltip\.interval":/);
  assert.match(dictionary, /"progression\.compare\.label":/);
  assert.match(dictionary, /"progression\.compare\.label":.*Сравнить прогрессию/);
  assert.match(dictionary, /"progression\.timeline\.legend\.metricSelected":/);
  assert.doesNotMatch(dictionary, /"progression\.timeline\.snapshotMarker":/);
  assert.doesNotMatch(`${panel}\n${chart}`, /observationDay|Observation day|День наблюдения/);
  assert.doesNotMatch(panel, /seasonal-risk data-panel/);

  assert.match(score, /risk\?: RiskInput \| null/);
  assert.match(score, /const normalized = normalizeRisk\(risk \?\? legacyRisk\)/);
  assert.match(score, /statsKnown === false/);
});

test("progression APIs keep Seasonal queries on the configured active cycle", async () => {
  const general = await readFile("app/api/progression/route.ts", "utf8");
  const legacy = await readFile("app/api/seasonal/progression/route.ts", "utf8");
  assert.match(general, /loadSeasonalCycleConfig\(\)\?\.cycleId !== input\.cycleId/);
  assert.match(legacy, /loadSeasonalCycleConfig\(\)\?\.cycleId !== input\.cycleId/);
});

test("profile charts reserve space and keep point inspection accessible", async () => {
  const styles = await readFile("components/profile.css", "utf8");
  const chart = await readFile("components/ProgressionTimelineChart.tsx", "utf8");
  assert.match(chart, /className="profile-line-chart" style=\{\{ height \}\}/);
  assert.match(chart, /className="profile-chart-hit"/);
  assert.match(chart, /onPointerLeave/);
  assert.match(chart, /tabIndex=\{0\}/);
  assert.match(chart, /aria-label=\{pointLabel\(item\)\}/);
  assert.doesNotMatch(chart, /tooltipRef/);
  assert.match(styles, /profile-chart-tooltip/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.doesNotMatch(styles, /cursor: (?:plus|zoom-in)/);
});

test("progression uses revision-aware five-hour bundle and timeline caches", async () => {
  const cache = await readFile("lib/seasonal/progression-cache.ts", "utf8");
  const flight = await readFile("lib/seasonal/progression-flight.ts", "utf8");
  const database = await readFile("lib/seasonal/progression-db.ts", "utf8");
  const general = await readFile("app/api/progression/route.ts", "utf8");
  const legacy = await readFile("app/api/seasonal/progression/route.ts", "utf8");

  assert.match(cache, /unstable_cache\(/);
  assert.match(cache, /PROGRESSION_CACHE_TTL_SECONDS = 18_000/);
  assert.match(cache, /\["progression-bundle-v4"\]/);
  assert.match(cache, /\["progression-timeline-v2"\]/);
  assert.match(cache, /async \(\s*mode: ProgressionMode,\s*cycleId: string,\s*aid: number,\s*_personalRevision: number,\s*_populationGeneration: number,/);
  assert.doesNotMatch(cache, /kind: ProgressionKind/);
  assert.match(cache, /throw new UncacheableProgressionResult\("unavailable"\)/);
  assert.match(cache, /throw new UncacheableProgressionResult\("not-found"\)/);
  assert.match(cache, /public, max-age=60, s-maxage=60, stale-while-revalidate=30/);
  assert.match(cache, /getLatestProgressionRevision\(\{ mode, cycleId, aid \}\)/);
  assert.match(cache, /`\$\{progressionFlightKey\(mode, cycleId, aid\)\}\\0\$\{revision \?\? "none"\}`/);
  assert.match(cache, /loadProgressionBundle\(mode, cycleId, aid, revision\)/);
  assert.match(cache, /getCachedProgressionTimeline/);
  assert.match(cache, /getProgressionTimelineRevisions\(\{ mode, cycleId, aid \}\)/);
  assert.match(cache, /loadProgressionTimeline\(mode, cycleId, aid, personalRevision, populationGeneration\)/);
  assert.match(cache, /\\0timeline\\0\$\{personalRevision\}\\0\$\{populationGeneration\}/);
  assert.match(flight, /load\(\)\.finally/);
  assert.match(flight, /inFlight\.delete\(key\)/);

  assert.match(database, /getProgressionBundleQuery/);
  assert.match(database, /getLatestProgressionRevision/);
  assert.match(database, /SELECT generation AS revision FROM progression_materializations/);
  assert.match(database, /PROGRESSION_KINDS\.map/);
  assert.match(database, /mergeProgressionBundle/);
  assert.equal(
    (database.match(/await details\(/g) ?? []).length,
    2,
    "shared details should run once for the bundle and once for the timeline",
  );
  for (const route of [general, legacy]) {
    assert.match(route, /getCachedProgressionBundle\(input\.mode, input\.cycleId, input\.aid\)/);
    assert.match(route, /result\.bundle\[input\.kind\]/);
    assert.match(route, /function errorResponse\(error: string, status: number\)/);
    assert.match(route, /\{ status, headers: \{ "Cache-Control": "no-store" \} \}/);
    assert.doesNotMatch(route, /NextResponse\.json\(\{ error:/);
  }
  assert.match(general, /input\.mode === "regular"[\s\S]*?"private, no-store"[\s\S]*?: PROGRESSION_CACHE_CONTROL/);
  assert.match(legacy, /"Cache-Control": PROGRESSION_CACHE_CONTROL/);
  assert.doesNotMatch(general, /searchParams[\s\S]*?revision/);
});

test("regular average mounts median raid progression and cumulative tooltips include XP level", async () => {
  const canonical = await readFile("app/average/[mode]/page.tsx", "utf8");
  const average = await readFile("app/average/page.tsx", "utf8");
  const progression = await readFile("components/RegularAverageProgression.tsx", "utf8");
  const chart = await readFile("components/SeasonalProgressionChart.tsx", "utf8");
  const route = await readFile("app/api/progression/average/route.ts", "utf8");
  const dictionary = await readFile("lib/i18n/dictionary.ts", "utf8");

  assert.match(canonical, /PLAYER_LEVELS_V2026_07_22/);
  assert.match(canonical, /levelBands=\{levelBands\}/);
  assert.doesNotMatch(canonical, /await getPlayerLevels\(\)/);
  assert.match(average, /mode === "regular" && levelBands\.length > 0/);
  assert.match(average, /<RegularAverageProgression levelBands=\{levelBands\} \/>/);
  assert.ok(
    average.indexOf("<RegularAverageProgression") < average.indexOf('t("average.fullMetrics")'),
    "regular progression should render before the full metric set",
  );
  assert.match(progression, /fetch\("\/api\/progression\/average"/);
  assert.match(progression, /data\?\.mode === mode/);
  assert.match(progression, /setData\(null\);\s*setError\(""\);/);
  assert.equal((progression.match(/averageOnly/g) ?? []).length, 3);
  assert.equal((progression.match(/mode="regular"/g) ?? []).length, 3);
  assert.match(chart, /levelAtExperience\(point\.value, levelBands\)/);
  assert.match(chart, /spacedLevelLabels\(/);
  assert.match(chart, /progression\.xpLevelValue/);
  assert.match(chart, /aria-label=\{label\}/);
  assert.match(chart, /function moscowTimestamp\(timestamp: number, lang: string\)/);
  assert.match(chart, /point\.periodStartAt == null \? null : moscowTimestamp\(point\.periodStartAt, lang\)/);
  assert.doesNotMatch(chart, /point\.periodStartAt[\s\S]*toISOString\(\)\.slice/);
  assert.match(route, /getRegularProgressionAverage\(\)/);
  assert.match(route, /AVERAGE_CACHE_CONTROL/);
  assert.match(route, /unstable_cache/);
  assert.match(dictionary, /"progression\.xpLevelValue": "XP \{xp\} · Level \{level\}"/);
  assert.match(dictionary, /"progression\.xpLevelValue": "опыт: \{xp\} · уровень \{level\}"/);
});
test("average dashboard publishes standard variants outside the web process and keeps HTTP warming manual", async () => {
  const cache = await readFile("lib/average-cache.ts", "utf8");
  const average = await readFile("app/api/average/route.ts", "utf8");
  const seasonal = await readFile("app/api/seasonal/average/route.ts", "utf8");
  const progression = await readFile("app/api/progression/average/route.ts", "utf8");
  const page = await readFile("app/average/page.tsx", "utf8");
  const warmer = await readFile("scripts/warm-average-cache.mjs", "utf8");
  const dockerfile = await readFile("Dockerfile", "utf8");
  const startup = await readFile("scripts/start-web.mjs", "utf8");
  const supervisor = await readFile("scripts/supervise-worker.mjs", "utf8");
  const materializer = await readFile("scripts/materialize-average-publications.mjs", "utf8");
  const publication = await readFile("lib/average-publication.ts", "utf8");
  const client = await readFile("lib/client-average-request.ts", "utf8");

  assert.match(cache, /30 \* 60/);
  assert.match(cache, /s-maxage=\$\{AVERAGE_CACHE_TTL_SECONDS\}/);
  assert.match(average, /\["average-dashboard-v2"\]/);
  assert.match(average, /mode: CrossSectionMode/);
  assert.match(seasonal, /\["average-seasonal-dashboard-v2"\]/);
  assert.match(progression, /\["average-progression-regular-v2"\]/);
  assert.match(page, /showAverageProgression = mode === "regular" \|\| mode === "pve" \|\| mode === "seasonal"/);
  assert.match(page, /showAverageProgression && levelBands\.length > 0/);
  assert.match(page, /const identity = `\$\{props\.mode \?\? "regular"\}:\$\{props\.cycleId \?\? "persistent"\}`/);
  assert.match(page, /<AveragePageContent key=\{identity\}/);
  for (const mode of ["regular", "pve", "arena"]) assert.match(warmer, new RegExp(`"${mode}"`));
  assert.match(warmer, /SEASONAL_CYCLE_ID/);
  assert.match(warmer, /api\/progression\/average\?mode=pve/);
  assert.match(warmer, /api\/average\/achievements\?mode=regular/);
  assert.match(warmer, /api\/average\/achievements\?mode=pve/);
  assert.match(warmer, /api\/average\/achievements\?mode=seasonal&cycle=/);
  assert.match(dockerfile, /warm-average-cache\.mjs/);
  assert.match(dockerfile, /start-web\.mjs/);
  assert.doesNotMatch(startup, /warm-average-cache\.mjs/);
  assert.doesNotMatch(startup, /AVERAGE_WARM_BASE_URL/);
  assert.match(startup, /materialize-average-publications\.mjs/);
  assert.match(startup, /superviseWorker\("average"/);
  assert.match(supervisor, /priority\(child\.pid, 19\)/);
  assert.doesNotMatch(materializer, /fetch\(|\/api\/average/);
  assert.match(materializer, /arenaProfileSyncActive/);
  assert.match(materializer, /arena_profile_sync_lease/);
  assert.match(materializer, /SQLITE_PATH/);
  assert.match(publication, /BEGIN IMMEDIATE/);
  assert.match(publication, /LIMIT 2/);
  assert.match(average, /readAveragePublication/);
  assert.match(seasonal, /readAveragePublication/);
  assert.match(client, /activePrefetches < 2/);
  assert.match(client, /slow-2g/);
});

test("Seasonal average invalidation keeps the server cache tagged and the JSON response uncached", async () => {
  const cache = await readFile("lib/average-cache.ts", "utf8");
  const seasonal = await readFile("app/api/seasonal/average/route.ts", "utf8");
  const sync = await readFile("app/api/operator/seasonal/profile-sync/route.ts", "utf8");

  assert.match(cache, /export const SEASONAL_AVERAGE_CACHE_TAG = "average-seasonal-dashboard-v2"/);
  assert.match(seasonal, /revalidate: AVERAGE_CACHE_TTL_SECONDS, tags: \[SEASONAL_AVERAGE_CACHE_TAG\]/);
  assert.match(seasonal, /if \(!query\) throw new SeasonalAverageUnavailableError\(\)/);
  assert.doesNotMatch(seasonal, /return \{ status: "unavailable" as const \}/);
  assert.match(seasonal, /"Cache-Control": "no-store"/);
  assert.match(sync, /import \{ revalidateTag \} from "next\/cache"/);
  assert.match(sync, /if \(result\.capture\.inserted === true\) \{\s*revalidateTag\(SEASONAL_AVERAGE_CACHE_TAG, "max"\);\s*await markAveragePublicationDirty\(seasonalPublicationScope\(cycle\.cycleId\)\);\s*\}/s);
  assert.doesNotMatch(sync, /warmAverageCaches|after\(/);
  assert.equal((sync.match(/revalidateTag\(/g) ?? []).length, 1);
  assert.ok(
    sync.indexOf("if (!result.ok)") < sync.indexOf("result.capture.inserted === true"),
    "failed captures must return before tag invalidation",
  );
});

test("PVP Season uses one canonical public route and keeps the internal seasonal identity", async () => {
  const modes = await readFile("types/seasonal.ts", "utf8");
  const averageRoute = await readFile("app/average/[mode]/page.tsx", "utf8");
  const playerRoute = await readFile("app/player/[[...segments]]/page.tsx", "utf8");
  const switcher = await readFile("components/ProfileModeSwitch.tsx", "utf8");
  const dictionary = await readFile("lib/i18n/dictionary.ts", "utf8");

  assert.match(modes, /SEASON_ROUTE_MODE = "pvp-season"/);
  assert.match(modes, /function appRouteMode\(mode: GameMode\)/);
  assert.match(modes, /function gameModeFromAppRoute\(value: unknown\)/);
  assert.match(averageRoute, /gameModeFromAppRoute\(routeMode\)/);
  assert.match(playerRoute, /gameModeFromAppRoute\(routeMode\)/);
  assert.match(averageRoute, /if \(!mode\) notFound\(\)/);
  assert.match(playerRoute, /if \(segments\.length < 1 \|\| segments\.length > 2 \|\| !aid \|\| !mode\) notFound\(\)/);
  assert.match(switcher, /const routeMode = appRouteMode\(mode\)/);
  assert.match(dictionary, /"fav\.mode\.seasonal": "PVP-SEASON"/);
  assert.match(dictionary, /"fav\.mode\.seasonal": "PVP-СЕЗОН"/);
});

test("PvE profiles use the persistent shell and mode-scoped UI data", async () => {
  const regular = await readFile("components/RegularPlayer.tsx", "utf8");
  const shell = await readFile("components/ProfileShell.tsx", "utf8");
  const progression = await readFile("components/ProgressionPanel.tsx", "utf8");
  const radar = await readFile("components/PlayerRadarComparison.tsx", "utf8");
  const achievements = await readFile("components/ProfileAchievements.tsx", "utf8");
  const dictionary = await readFile("lib/i18n/dictionary.ts", "utf8");

  assert.match(regular, /if \(mode === "regular" \|\| mode === "pve"\)/);
  assert.match(regular, /<ProfileShell[\s\S]*?mode=\{mode\}[\s\S]*?overviewCards=\{regularOverviewCards\}/);
  assert.match(regular, /<ProgressionPanel[\s\S]*?mode=\{mode\}[\s\S]*?cycleId="persistent"/);
  assert.match(regular, /<CheaterScore compact risk=\{serverRisk \?\? progressionRisk\}[\s\S]*?mode=\{mode\}[\s\S]*?statsKnown=\{mode === "regular" \? pvpStatsKnown : true\}/);
  assert.match(regular, /<PlayerRadarComparison[\s\S]*?stats=\{stats\} mode=\{mode\} cycleId="persistent"/);
  assert.match(regular, /<ProfileAchievements[\s\S]*?mode=\{mode\}[\s\S]*?cycleId="persistent"/);
  assert.match(regular, /hasVisibleSkills\(regularSkillItems\)/);
  assert.match(shell, /mode === "regular" \|\| mode === "pve" \|\| mode === "seasonal"/);
  assert.match(shell, /\(mode === "regular" \|\| mode === "pve" \|\| mode === "seasonal"\) &&/);
  assert.match(progression, /mode\?: "regular" \| "pve" \| "seasonal"/);
  assert.match(radar, /if \(mode === "arena"\)/);
  assert.doesNotMatch(radar, /if \(mode !== "regular" && mode !== "seasonal"\)/);
  assert.match(achievements, /mode: "regular" \| "pve" \| "seasonal"/);
  assert.match(dictionary, /"progression\.kicker\.pve": "PvE history"/);
  assert.match(dictionary, /"progression\.kicker\.pve": "История PvE"/);
});

test("PvE averages include the persistent progression charts", async () => {
  const page = await readFile("app/average/page.tsx", "utf8");
  const route = await readFile("app/average/[mode]/page.tsx", "utf8");
  const averageProgression = await readFile("components/RegularAverageProgression.tsx", "utf8");
  const chart = await readFile("components/SeasonalProgressionChart.tsx", "utf8");

  assert.match(page, /mode === "regular" \|\| mode === "pve" \|\| mode === "seasonal"/);
  assert.match(page, /mode=\{mode === "seasonal" \? "seasonal" : mode === "pve" \? "pve" : "regular"\}/);
  assert.match(route, /if \(mode === "regular" \|\| mode === "pve"\)/);
  assert.match(averageProgression, /mode\?: "regular" \| "pve" \| "seasonal"/);
  assert.match(averageProgression, /if \(mode !== "regular"\)/);
  assert.match(chart, /const persistent = mode !== "seasonal"/);
});

test("the shell renders no section anchor for an empty slot and links only rendered ones", async () => {
  const shell = await readFile("components/ProfileShell.tsx", "utf8");

  assert.match(shell, /function hasSectionContent\(children: ReactNode\): boolean \{\s*return children !== undefined && children !== null && children !== false;/);
  assert.match(shell, /function ProfileShellSection\(\{ id, children \}[\s\S]*?if \(!hasSectionContent\(children\)\) return null;/);
  assert.match(shell, /const sectionIds = baseSectionIds\.filter\(\(id\) =>\s*id === "overview" \|\| hasSectionContent\(sectionContent\[id\]\)/);
  assert.doesNotMatch(shell, /achievements !== undefined && <ProfileShellSection/);
  assert.match(shell, /\{\(hasSectionContent\(risk\) \|\| hasSectionContent\(comparison\)\) && \(\s*<div className="profile-analysis">/);
});

test("an unknown progression survival rate is never rendered as a percentage", async () => {
  const panel = await readFile("components/ProgressionPanel.tsx", "utf8");
  const card = await readFile("components/StatCard.tsx", "utf8");

  // The progression placeholder is the local helper's em dash, not a dictionary value, so
  // the defect reads `—%` in both languages. `number()` emits it for a null, an undefined,
  // and a missing `longTerm`, which is what an empty interval set produces.
  assert.match(
    panel,
    /function number\(value: number \| null \| undefined, digits = 1\): string \{\s*return value == null \|\| !Number\.isFinite\(value\)\s*\? "\u2014"/,
  );

  // The general rule: a value built from `number()` may be that placeholder, so it must
  // not also carry a literal suffix. Asserted over every such card in the file rather than
  // on one line, so a new one cannot reintroduce it.
  const placeholderCards = panel.split("\n").filter((line) => line.includes("value={number("));
  assert.ok(placeholderCards.length >= 4, `expected the progression placeholder cards, found ${placeholderCards.length}`);
  for (const line of placeholderCards) {
    assert.doesNotMatch(line, /suffix="/, `a placeholder value must not carry a literal suffix: ${line.trim()}`);
  }

  // The guard is the same expression the value is computed from, so it cannot drift from
  // the fallback: an absent `longTerm` and a null `survivalRate` both withhold the unit.
  assert.match(
    panel,
    /<StatCard label=\{t\("seasonal\.metric\.survival"\)\} value=\{number\(longTerm\?\.survivalRate\)\} suffix=\{longTerm\?\.survivalRate == null \? undefined : "%"\} \/>/,
  );
  // The siblings in the same block are dimensionless ratios and must stay suffix-free.
  assert.match(panel, /<StatCard label=\{t\("seasonal\.metric\.pvpKd"\)\} value=\{number\(longTerm\?\.pvpKd\)\} \/>/);
  assert.equal(placeholderCards.filter((line) => /suffix[:={]/.test(line)).length, 1, "the survival card is the only suffixed card in the block");

  // The renderer and the helper stay generic: each prints what the caller supplies, and
  // neither learns what a placeholder string means.
  assert.match(card, /\{suffix && <span className="metric-card__suffix ml-1">\{suffix\}<\/span>\}/);
  assert.doesNotMatch(panel, /common\.unknown|common\.notAvailable/);
});
