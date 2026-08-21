import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("favorites are global by AID while mode widgets project the preferred link into their current identity", async () => {
  const context = await readFile("lib/favorites/context.tsx", "utf8");
  const route = await readFile("app/api/favorites/route.ts", "utf8");
  const store = await readFile("lib/db.ts", "utf8");
  const schema = await readFile("lib/favorites-schema.ts", "utf8");
  const panel = await readFile("components/ProgressionPanel.tsx", "utf8");
  const radar = await readFile("components/PlayerRadarComparison.tsx", "utf8");

  assert.match(context, /function matches\(favorite: Favorite, aid: number\)[\s\S]*favorite\.aid === aid/);
  assert.doesNotMatch(context, /favorite\.mode === id\.mode|favorite\.cycleId === id\.cycleId/);
  assert.match(context, /body: JSON\.stringify\(\{ aid, nickname, mode: id\.mode, cycle: id\.cycleId \}\)/);
  assert.ok((context.match(/if \(!res\.ok\) throw new Error\(\)/g) ?? []).length >= 4);
  assert.ok((context.match(/await refresh\(\)/g) ?? []).length >= 4);

  assert.match(route, /store\.add\([\s\S]*identity/);
  assert.match(route, /store\.remove\(g\.sub, aid\)/);
  assert.ok((route.match(/Storage unavailable/g) ?? []).length >= 3);
  assert.match(route, /store\.setMain\(g\.sub, aid\)/);
  assert.match(route, /store\.setNote\(g\.sub, aid, clean\(body\.note, NOTE_MAX\)\)/);
  assert.doesNotMatch(route, /store\.(?:remove|setMain|setNote)\(g\.sub, aid,[^)]*identity/);

  assert.match(schema, /INSERT OR IGNORE INTO favorites[\s\S]*COUNT\(DISTINCT aid\)/);
  assert.match(schema, /SET is_main = CASE WHEN aid = \? THEN 1 ELSE 0 END/);
  assert.match(schema, /throw new Error\("Favorite insert was ignored unexpectedly"\)/);
  assert.ok((store.match(/prepare\(FAVORITE_INSERT_SQL\)/g) ?? []).length >= 2);
  assert.ok((store.match(/prepare\(FAVORITE_SET_MAIN_SQL\)/g) ?? []).length >= 2);
  assert.match(store, /inserted\?\.meta\?\.changes \?\? 0/);
  assert.match(store, /favoriteInsertResult\(inserted\.changes/);
  assert.ok((store.match(/DELETE FROM favorites WHERE user_sub = \? AND aid = \?/g) ?? []).length >= 2);
  assert.ok((store.match(/UPDATE favorites SET note = \? WHERE user_sub = \? AND aid = \?/g) ?? []).length >= 2);
  assert.ok((store.match(/UPDATE favorites SET nickname = \? WHERE user_sub = \? AND aid = \?/g) ?? []).length >= 2);

  for (const source of [panel, radar]) {
    assert.match(source, /favorites\.filter\(\(favorite\) => favorite\.aid !== aid\)/);
    assert.doesNotMatch(source, /favorite\.mode === mode && favorite\.cycleId === cycleId/);
  }
  assert.match(panel, /mode,\s*cycle: cycleId,\s*aid: String\(favorite\.aid\)/);
  assert.match(radar, /aid: String\(effectiveFavoriteAid\),\s*mode,\s*cycle: cycleId/);
  assert.match(radar, /const nextStats = payload\.comparisonStats \?\? payload\.stats/);
  assert.doesNotMatch(radar, /payload\.viewModel\?\.comparison \?\? payload\.stats/);
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
  assert.match(source, /throw new Error\(data\.error \?\? t\("player\.loadError"\)\)/);
  assert.match(source, /if \(error \|\| !stats\)[\s\S]*?\{error \|\| t\("player\.unknownError"\)\}/);
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
  assert.match(shell, /id="progression"[\s\S]*?id="risk"[\s\S]*?id="comparison"[\s\S]*?id="statistics"[\s\S]*?id="skills"/);
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
  assert.match(shell, /ProfileShellLoading[\s\S]*<ProfileModeSwitch current=\{mode\}/);
  assert.match(modes, /prefetch/);
  assert.match(modes, /scroll=\{false\}/);
  assert.match(modes, /aria-current=\{mode === current \? "page" : undefined\}/);
  assert.match(modes, /aria-busy=\{pending \|\| undefined\}/);
  assert.match(modes, /const pathname = usePathname\(\)/);
  assert.match(modes, /pendingNavigation\.fromMode === current &&[\s\S]*pendingNavigation\.pathname === pathname/);
  assert.match(modes, /window\.setTimeout\(\(\) => setPendingNavigation\(null\), PENDING_TIMEOUT_MS\)/);
  assert.match(modes, /onNavigate=\{\(\) => \{[\s\S]*window\.dispatchEvent\(new Event\("profile-mode-navigate"\)\)/);
  assert.doesNotMatch(modes, /event\.preventDefault\(\)[\s\S]*router\.push\(target/);
  assert.equal((modes.match(/profile-mode-navigate/g) ?? []).length, 1);
  assert.match(styles, /\.profile-header__mode \.mode-switch/);
  assert.doesNotMatch(styles, /\.profile-route-modebar/);
});

test("profile mode switching is available during loading and capture is post-response", async () => {
  const regular = await readFile("components/RegularPlayer.tsx", "utf8");
  const route = await readFile("app/api/player/profile/route.ts", "utf8");

  assert.match(regular, /const forceRefresh = isReload\(\)/);
  assert.match(regular, /cache: forceRefresh \? "no-store" : "default"/);
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
  assert.match(route, /const regularSnapshot = makePlayerSnapshot/);
  assert.match(route, /after\(\(\) => persistRegularProfileSnapshot\(regularSnapshot, \{ upsertPlayer: !\(fromCache \|\| fromEdgeCache\) \}\)/);
  assert.doesNotMatch(route, /await persistRegularProfileSnapshot/);
  assert.match(route, /const riskIsFresh = publicRisk &&[\s\S]*Date\.now\(\) - publicRisk\.evaluatedAt < 5 \* 60 \* 60 \* 1000/);
  assert.match(route, /after\(async \(\) => \{[\s\S]*setTimeout\(resolve, 1_000\)[\s\S]*await evaluateAndStoreRisk/);
  assert.match(route, /const seasonalRiskIsFresh = result\.ok && storedRisk &&[\s\S]*storedRisk\.profileUpdatedAt >= result\.profile\.profileUpdatedAt[\s\S]*Date\.now\(\) - storedRisk\.evaluatedAt < 5 \* 60 \* 60 \* 1000/);
  assert.match(route, /if \(result\.ok && !seasonalRiskIsFresh\) \{[\s\S]*after\(async \(\) => \{[\s\S]*setTimeout\(resolve, 1_000\)[\s\S]*await evaluateAndStoreSeasonalRisk/);
  assert.ok(route.indexOf("const storedRisk = result.ok") < route.indexOf("if (result.ok && !seasonalRiskIsFresh)"));
  assert.match(route, /const \[baseline, metadata\] = await Promise\.all\(\[[\s\S]*getAchievements\("seasonal"\)\.catch/);
  assert.doesNotMatch(route, /getCachedAchievements\("seasonal"\)/);
  assert.match(route, /metadata\.get\(achievement\.id\)/);
});

test("profile navigation exposes the shell immediately and overlaps regular API work", async () => {
  const loading = await readFile("app/player/loading.tsx", "utf8");
  const search = await readFile("components/SearchBar.tsx", "utf8");

  assert.match(loading, /usePathname/);
  assert.match(loading, /parsePlayerId/);
  assert.match(loading, /<ProfileShellLoading mode=\{mode\} aid=\{aid\} \/>/);
  assert.match(search, /const profileParams = new URLSearchParams\(\{ aid: String\(player\.aid\), mode: player\.mode \}\)/);
  assert.match(search, /fetch\(`\/api\/player\/profile\?\$\{profileParams\}`, \{ cache: "default" \}\)/);
  assert.match(search, /player\.mode === "regular"/);
  assert.match(search, /const timelineParams = new URLSearchParams\(\{ mode: "regular", cycle: "persistent", aid: String\(player\.aid\) \}\)/);
  assert.match(search, /fetch\(`\/api\/progression\/timeline\?\$\{timelineParams\}`, \{ cache: "default" \}\)/);
  assert.match(search, /router\.push\(href\)/);
});

test("visitor help is hidden from home without deleting its implementation", async () => {
  const home = await readFile("components/HomePage.tsx", "utf8");
  assert.doesNotMatch(home, /CommunityHelper/);
  await access("components/CommunityHelper.tsx");
  await access("app/api/community/ban-reviews/claim/route.ts");
});

test("average statistic switch keeps URL state and masks stale portrait values", async () => {
  const source = await readFile("app/average/page.tsx", "utf8");
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
  assert.match(source, /name="average-statistic"/);
  assert.match(source, /average-settings__top[\s\S]*average-settings__groups[\s\S]*average-settings__mode/);
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

  for (const modifier of ["metaKey", "ctrlKey", "shiftKey", "altKey"]) {
    assert.match(helper, new RegExp(`event\\.${modifier}`));
  }
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
  assert.match(source, /name="average-period"/);
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
  assert.match(source, /name=\{`radar-statistic-\$\{aid\}`\}/);
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
  assert.match(source, /name=\{`radar-period-\$\{aid\}`\}/);
});

test("radar keeps raw player values independent from baseline availability", async () => {
  const source = await readFile("components/PlayerRadarComparison.tsx", "utf8");

  assert.match(source, /const activeBaseline = active\?\.available \? active\.average\.value : null/);
  assert.match(source, /formatValue\(active\.metric, playerValues\[active\.metric\.key\]\)/);
  assert.match(source, /ratioText\(playerValues\[active\.metric\.key\], activeBaseline\)/);
  assert.match(source, /active\.available[\s\S]*?radar\.baselineUnavailable/);
  assert.match(source, /axis\.available[\s\S]*?formatValue\(axis\.metric, axis\.average\.value\)[\s\S]*?radar\.baselineUnavailable/);
  assert.match(source, /\{t\("radar\.baselineUnavailable"\)\}/);
});

test("profile refresh checks automatically after returning without requiring F5", async () => {
  const button = await readFile("components/RefreshButton.tsx", "utf8");
  const profile = await readFile("components/RegularPlayer.tsx", "utf8");

  assert.match(button, /window\.addEventListener\("focus", handleFocus\)/);
  assert.match(button, /awaitingReturn\.current = true/);
  assert.match(button, /if \(!onCheck\) return/);
  assert.match(button, /if \(!onCheck \|\| checking\.current\) return/);
  assert.match(button, /player\.refreshCheckAgain/);
  assert.match(button, /onCheck && status !== "idle"/);
  assert.match(button, /aria-live="polite"/);
  assert.match(profile, /new URLSearchParams\(\{ aid, mode, refresh: "1" \}\)/);
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
  assert.match(seasonal, /stale=\{profileIsStale\}/);
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
  assert.equal(isProfileStale(now - PROFILE_STALE_MS - 1, now), true);
  assert.equal(isProfileStale(null, now), false);
});

test("unknown regular PvP stats are not rendered or scored as zero", async () => {
  const profile = await readFile("components/RegularPlayer.tsx", "utf8");
  const radar = await readFile("components/PlayerRadarComparison.tsx", "utf8");
  const score = await readFile("components/CheaterScore.tsx", "utf8");

  assert.match(profile, /const pvpStatsKnown = stats\.pvpStatsKnown !== false/);
  assert.match(profile, /pvpStatsKnown \? stats\.pmcKdRatio : t\("common\.notAvailable"\)/);
  assert.match(profile, /pvpStatsKnown \? stats\.killedPmc\.toLocaleString\(\) : t\("common\.notAvailable"\)/);
  assert.match(radar, /playerValues = demo[\s\S]*?playerStatsKnown \? valuesFromStats\(stats\) : null/);
  assert.match(radar, /favoriteStats && favoriteStatsKnown/);
  assert.match(radar, /radar\.incompletePvp\.player/);
  assert.match(radar, /radar\.incompletePvp\.favorite/);
  assert.match(score, /statsKnown === false/);
  assert.match(score, /cheater\.incompletePvp/);
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
  assert.match(profile, /risk=\{<div><h2 className="section-heading mb-3">\{t\("cheater\.heading"\)\}<\/h2><CheaterScore/);
  assert.match(shell, /id="progression"[\s\S]*?id="risk"[\s\S]*?id="comparison"[\s\S]*?id="statistics"[\s\S]*?id="skills"/);
  assert.doesNotMatch(score, /section-kicker">\{t\("cheater\.heading"\)\}/);
  assert.match(profile, /<ProgressionPanel[\s\S]*?mode="regular"[\s\S]*?cycleId="persistent"/);
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
  assert.match(panel, /\[aid, cycleId, forceRefresh, mode, onRiskChange, profileUpdatedAt, refreshRevision, t\]/);
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
  assert.match(panel, /min-h-11/);
  assert.match(panel, /aria-live="polite"/);
  assert.match(chart, /cumulativeLevelBands/);
  assert.match(chart, /niceXpDomain/);
  assert.match(chart, /chartPath/);
  assert.match(chart, /clipPath/);
  assert.match(chart, /data-metric=\{(?:metric|item)\.key\}/);
  assert.match(chart, /role="radio"/);
  assert.match(chart, /aria-checked=\{active\}/);
  assert.doesNotMatch(chart, /previewMetric/);
  assert.match(chart, /const \[compareOverall, setCompareOverall\] = useState\(true\)/);
  assert.match(chart, /focusPlayer/);
  assert.match(chart, /animated(?:Raid)?DomainRef = useRef/);
  assert.match(chart, /requestAnimationFrame\(step\)/);
  assert.match(chart, /cancelAnimationFrame\(frame\)/);
  assert.match(chart, /prefers-reduced-motion/);
  assert.match(chart, /const PLAYER_MARKER_CLEARANCE = 14/);
  assert.match(chart, /resolveMetricDomain/);
  assert.match(chart, /targetForegroundPoints\.player/);
  assert.match(chart, /targetXpPoints\.player/);
  assert.match(chart, /function seriesPath/);
  assert.match(chart, /const MAX_AGGREGATE_POINTS = 48/);
  assert.match(chart, /seriesKey === "player"[\s\S]*compactProgressionPoints\(sourcePoints, MAX_AGGREGATE_POINTS\)/);
  assert.match(chart, /const \[metricReveal, setMetricReveal\] = useState\(1\)/);
  assert.match(chart, /metricRevealRaids/);
  assert.match(chart, /progression-timeline__metric-reveal/);
  assert.match(chart, /clipPath=\{`url\(#\$\{clipId\}-metric-reveal\)`\}/);
  assert.match(chart, /const rawYForPoint =/);
  assert.match(chart, /Math\.min\(animatedYDomains\.metric\.min, resolvedMetricDomain\.min\)/);
  assert.match(chart, /markerCollisionRingRadii\(\[/);
  assert.match(chart, /playerMarkerRings\[markerKey\(layer, isSelectedSeries \? "selected" : "player", point\)\]/);
  assert.match(chart, /seriesPath\(seriesPoints, timelineAxis, xForPoint, rawYForPoint, PAD\.top\)/);
  assert.match(chart, /seriesPath\(\[from, to\], timelineAxis, xForPoint, rawYForPoint, PAD\.top\)/);
  assert.match(chart, /y: \(rawYForPoint\(from\) \+ rawYForPoint\(to\)\) \/ 2/);
  assert.match(chart, /progression-timeline__point--ring/);
  assert.doesNotMatch(chart, /metricLineShouldBeAboveXp|visualYForPoint|metricAboveXp/);
  assert.doesNotMatch(chart, /splitLanes|laneHeight|metricLane|xpLane|lane-divider/);
  assert.match(chart, /onClick=\{\(\) => setFocusPlayer\(\(current\) => !current\)\}/);
  assert.doesNotMatch(chart, /xp_per_day|pmc_raids_per_day|pmc_kills_per_day|non_pmc_kills_per_day/);
  assert.doesNotMatch(chart, /pmc_kills_per_raid|non_pmc_kills_per_raid/);
  for (const metric of ["pvp_kd", "ai_kd", "survival"]) {
    assert.match(chart, new RegExp(`key: "${metric}"`));
  }
  const focusBackground = chart.match(/<rect[\s\S]*?className="progression-timeline__focus-background"[\s\S]*?\/>/)?.[0] ?? "";
  assert.match(focusBackground, /aria-hidden="true"/);
  assert.match(focusBackground, /pointerEvents="all"/);
  assert.match(focusBackground, /onClick=\{\(\) => setFocusPlayer\(\(current\) => !current\)\}/);
  const lineHitArea = chart.match(/<path[\s\S]*?className="progression-timeline__hit-area"[\s\S]*?\/>/)?.[0] ?? "";
  assert.ok(lineHitArea, "line hit area should remain a sibling of the focus background");
  assert.doesNotMatch(lineHitArea, /onClick|setFocusPlayer/);
  const point = chart.match(/<circle[\s\S]*?className=\{`progression-timeline__point[\s\S]*?\/>/)?.[0] ?? "";
  assert.ok(point, "point interaction should remain independent from the focus background");
  assert.doesNotMatch(point, /onClick|setFocusPlayer/);
  assert.match(chart, /progression-timeline__focus-hint/);
  assert.doesNotMatch(chart, /progression-timeline__focus-toggle/);
  assert.doesNotMatch(chart, /progression\.timeline\.focus\.(?:player|all)/);
  assert.match(chart, /tooltip(?:Anchor|Position|Overlay)/i);
  assert.match(chart, /role="(?:status|tooltip)"/);
  assert.match(chart, /aria-live="polite"/);
  assert.doesNotMatch(chart, /className="progression-timeline__tooltip"/);
  assert.doesNotMatch(chart, /<title>\{label\}<\/title>/);
  assert.match(chart, /onPointerEnter/);
  assert.match(chart, /progression-timeline__hit-area/);
  assert.match(chart, /progression\.timeline\.tooltip\.interval/);
  assert.match(chart, /progression\.timeline\.tooltip\.levelDelta/);
  assert.match(chart, /const includeLevelDelta = selected === null/);
  const pointTooltip = chart.match(/const tooltipPointText = \([\s\S]*?\n  \};/)?.[0] ?? "";
  assert.match(pointTooltip, /dateLabel\(point\.date\)/);
  assert.doesNotMatch(pointTooltip, /tooltip\.pointTitle|tooltip\.date/);
  assert.match(chart, /const tooltipPointAriaLabel =/);
  const intervalTooltip = chart.match(/const tooltipIntervalText = \([\s\S]*?\n  \};/)?.[0] ?? "";
  assert.match(intervalTooltip, /progression\.timeline\.tooltip\.interval/);
  assert.doesNotMatch(intervalTooltip, /metricLabel|SERIES_LABELS\[series\]/);
  assert.match(chart, /const tooltipIntervalAriaLabel =/);
  assert.match(chart, /x=\{PAD\.left - 2\}/);
  assert.match(chart, /x=\{WIDTH - PAD\.right - 2\}[^>]*textAnchor="end"[^>]*axis-label--metric/);
  assert.match(chart, /const targetXpDomain = focusPlayer\s*\?\s*progressionValueDomain/);
  assert.match(chart, /const animatedYDomainsRef = useRef/);
  assert.match(chart, /progression-timeline__level-tick/);
  assert.doesNotMatch(chart, /progression-timeline__(?:risk|snapshot)-(?:rail|marker|dot)/);
  assert.doesNotMatch(chart, /riskMarkers|markerList|markerPoints/);
  assert.match(chart, /overall: \{ dash: "1 5", opacity: \.5, width: 1\.5/);
  assert.doesNotMatch(chart, /new Map\(source\.map\(\(marker\) => \[marker\.date/);
  assert.match(chart, /progression-timeline__area--xp/);
  assert.match(chart, /progression-timeline__legend/);
  assert.match(chart, /legend-item--overall \$\{overallLegendState\.highlighted/);
  assert.match(chart, /onPointerEnter=\{\(\) => setLayerHover\("xp"\)\}/);
  assert.match(chart, /onPointerEnter=\{\(\) => setSeriesHover\(selectedMetric, "overall"\)\}/);
  assert.match(chart, /const legendItemState = \(layer: TimelineLayer, series\?: HoverSeriesKey\)/);
  assert.match(chart, /type HoverSeriesKey = SeriesKey \| "selected"/);
  assert.match(chart, /comparison\?: \{[\s\S]*?aid: number[\s\S]*?nickname: string[\s\S]*?timeline: ProgressionTimelineResponse/);
  assert.match(chart, /const selectedXpSource = useMemo/);
  assert.match(chart, /const selectedMetricSource = useMemo/);
  assert.match(chart, /comparison\?\.timeline\.metrics\.xp\?\.player/);
  assert.doesNotMatch(chart, /comparison\?\.timeline\.metrics\.xp\?\.(?:nearby|overall)/);
  assert.match(chart, /const targetPlayerXpPoints = \[\.\.\.targetXpPoints\.player, \.\.\.targetSelectedXpPoints\]/);
  assert.match(chart, /const targetPlayerMetricPoints = \[\.\.\.targetForegroundPoints\.player, \.\.\.targetSelectedForegroundPoints\]/);
  assert.match(chart, /metricDomainSamplesFor\(targetPlayerMetricPoints\)/);
  assert.match(chart, /timelineAxis === "days"/);
  assert.match(chart, /SELECTED_SERIES_STYLE = \{ dash: "7 4 1 4"/);
  assert.match(chart, /progression-timeline__legend-item--selected/);
  assert.match(chart, /markerCollisionRingRadii/);
  assert.match(chart, /tooltipPointText\(hoveredPoint\.point, hoveredPoint\.metric, hoveredPoint\.series\)/);
  assert.match(chart, /progression-timeline__axis-label--metric \$\{metricLayerHighlighted/);
  assert.match(chart, /progression-timeline__axis-guide-item--level \$\{xpLayerHighlighted/);
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

test("progression hover states reserve space and never switch to a plus cursor", async () => {
  const styles = await readFile("app/globals.css", "utf8");
  const chart = await readFile("components/ProgressionTimelineChart.tsx", "utf8");

  assert.match(styles, /progression-timeline__chart-frame[^}]*height: 360px/);
  assert.match(styles, /progression-timeline__metric-radio[^}]*min-height: 44px/);
  assert.doesNotMatch(styles, /progression-timeline__hit-area[^}]*cursor: crosshair/);
  assert.match(styles, /progression-timeline__line--dim[^}]*opacity/);
  assert.match(styles, /progression-timeline__line--segment-context[^}]*opacity/);
  assert.match(styles, /progression-timeline__interval-highlight[^}]*stroke-linecap: round/);
  assert.match(styles, /progression-timeline__level-grid[^}]*stroke-width: \.75[^}]*stroke-dasharray: none/);
  assert.match(styles, /progression-timeline__line--overall[^}]*stroke-width: 1\.5/);
  assert.match(styles, /progression-timeline__line--selected[^}]*stroke-dasharray: 7 4 1 4/);
  assert.match(styles, /progression-timeline__point--selected[^}]*fill: transparent/);
  assert.match(styles, /progression-timeline__legend-swatch--selected[^}]*repeating-linear-gradient/);
  assert.match(styles, /@media \(max-width: 420px\)[\s\S]*progression-timeline__compare-select[^}]*min-height: 44px/);
  assert.match(styles, /progression-timeline__point--overall[^}]*opacity: \.58/);
  assert.match(styles, /progression-timeline__hit-area[^}]*stroke-width: 11/);
  assert.match(styles, /progression-timeline__point[^}]*pointer-events: all/);
  assert.match(styles, /progression-timeline__point--dim[^}]*filter: blur/);
  assert.match(chart, /strokeWidth=\{11\}/);
  assert.match(chart, /r=\{markerRing \? .*seriesKey === "player" \|\| isSelectedSeries \? 5 : 3\.5\}/);
  assert.match(chart, /prefers-reduced-motion/);
  assert.match(chart, /const activeInterval = hoveredInterval\?\.layer === layer/);
  assert.doesNotMatch(chart, /progression-timeline__interval-guide/);
  assert.match(chart, /progression-timeline__tooltipOverlay--\$\{tooltipPlacement\?\.horizontal/);
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
    3,
    "shared details should run once per legacy storage implementation and once for the combined timeline",
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
  assert.match(chart, /function moscowTimestamp\(timestamp: number\)/);
  assert.match(chart, /point\.periodStartAt == null \? null : moscowTimestamp\(point\.periodStartAt\)/);
  assert.doesNotMatch(chart, /point\.periodStartAt[\s\S]*toISOString\(\)\.slice/);
  assert.match(route, /getRegularProgressionAverage\(\)/);
  assert.match(route, /AVERAGE_CACHE_CONTROL/);
  assert.match(route, /unstable_cache/);
  assert.match(dictionary, /"progression\.xpLevelValue": "XP \{xp\} · Level \{level\}"/);
  assert.match(dictionary, /"progression\.xpLevelValue": "опыт: \{xp\} · уровень \{level\}"/);
});
test("average dashboard warms every mode and skips PvP progression for PvE/Arena", async () => {
  const cache = await readFile("lib/average-cache.ts", "utf8");
  const average = await readFile("app/api/average/route.ts", "utf8");
  const seasonal = await readFile("app/api/seasonal/average/route.ts", "utf8");
  const progression = await readFile("app/api/progression/average/route.ts", "utf8");
  const page = await readFile("app/average/page.tsx", "utf8");
  const warmer = await readFile("scripts/warm-average-cache.mjs", "utf8");
  const dockerfile = await readFile("Dockerfile", "utf8");
  const startup = await readFile("scripts/start-web.mjs", "utf8");

  assert.match(cache, /30 \* 60/);
  assert.match(cache, /s-maxage=\$\{AVERAGE_CACHE_TTL_SECONDS\}/);
  assert.match(average, /\["average-dashboard-v2"\]/);
  assert.match(average, /mode: CrossSectionMode/);
  assert.match(seasonal, /\["average-seasonal-dashboard-v2"\]/);
  assert.match(progression, /\["average-progression-regular-v2"\]/);
  assert.match(page, /showAverageProgression = mode === "regular" \|\| mode === "seasonal"/);
  assert.match(page, /showAverageProgression && levelBands\.length > 0/);
  for (const mode of ["regular", "pve", "arena"]) assert.match(warmer, new RegExp(`"${mode}"`));
  assert.match(warmer, /SEASONAL_CYCLE_ID/);
  assert.match(warmer, /api\/average\/achievements\?mode=regular/);
  assert.match(warmer, /api\/average\/achievements\?mode=seasonal&cycle=/);
  assert.match(dockerfile, /warm-average-cache\.mjs/);
  assert.match(dockerfile, /start-web\.mjs/);
  assert.match(startup, /warm-average-cache\.mjs/);
  assert.match(startup, /AVERAGE_WARM_BASE_URL/);
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
  assert.match(sync, /if \(result\.capture\.inserted === true\) \{\s*revalidateTag\(SEASONAL_AVERAGE_CACHE_TAG, \{ expire: 0 \}\);/s);
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
