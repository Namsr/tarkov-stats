import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

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
  assert.match(header, /profile-header__controls[\s\S]*profile-header__actions[\s\S]*profile-header__mode[\s\S]*<ProfileModeSwitch/);
  assert.doesNotMatch(styles, /\.profile-header__mode \{[^}]*border/);
  assert.match(regular, /<ProfileSectionNav[^>]*items=\{sectionLinks\} \/>[\s\S]*?<ProfileHeader/);
  assert.match(seasonal, /<ProfileSectionNav[\s\S]*?<ProfileHeader/);
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
  assert.match(modes, /handleActiveLinkClick\(event, mode === current, router\)/);
  assert.match(modes, /aria-current=\{mode === current \? "page" : undefined\}/);
  assert.match(seasonalAverage, /average-settings__top[\s\S]*average-settings__mode md:col-start-2/);
});

test("regular average period switch keeps URL state and masks stale responses", async () => {
  const source = await readFile("app/average/page.tsx", "utf8");

  assert.match(source, /mode === "regular" && searchParams\.get\("period"\) === "90d"/);
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
  assert.match(source, /requestId: `\$\{sourceAid\}:\$\{mode\}:\$\{dimension\}:\$\{center\}:\$\{/);
  assert.match(source, /remoteCohort\?\.requestId === `\$\{aid\}:\$\{mode\}:\$\{dimension\}:\$\{center\}:\$\{statistic\}:/);
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
  assert.match(source, /if \(!controller\.signal\.aborted\) setRemoteCohort\(payload\)/);
  assert.match(source, /period,\s*\}\);/);
  assert.match(source, /requestId: `\$\{sourceAid\}:\$\{mode\}:\$\{dimension\}:\$\{center\}:\$\{input\.statistic \?\? statistic\}:\$\{input\.period \?\? period\}`/);
  assert.match(source, /remoteCohort\?\.requestId === `\$\{aid\}:\$\{mode\}:\$\{dimension\}:\$\{center\}:\$\{statistic\}:\$\{period\}`/);
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
  assert.equal((profile.match(/player\.profileUpdated/g) ?? []).length, 1);
});

test("unknown regular PvP stats are not rendered or scored as zero", async () => {
  const profile = await readFile("components/RegularPlayer.tsx", "utf8");
  const radar = await readFile("components/PlayerRadarComparison.tsx", "utf8");
  const score = await readFile("components/CheaterScore.tsx", "utf8");

  assert.match(profile, /mode !== "regular" \|\| stats\.pvpStatsKnown !== false/);
  assert.match(profile, /pvpStatsKnown \? stats\.pmcKdRatio : t\("common\.notAvailable"\)/);
  assert.match(profile, /pvpStatsKnown \? stats\.killedPmc\.toLocaleString\(\) : t\("common\.notAvailable"\)/);
  assert.match(radar, /playerStatsKnown \? valuesFromStats\(stats\) : null/);
  assert.match(radar, /favoriteStats && favoriteStatsKnown/);
  assert.match(radar, /radar\.incompletePvp\.player/);
  assert.match(radar, /radar\.incompletePvp\.favorite/);
  assert.match(score, /if \(!pvpStatsKnown\)/);
  assert.match(score, /cheater\.incompletePvp/);
});

test("regular PvP progression precedes the single risk card and radar", async () => {
  const profile = await readFile("components/RegularPlayer.tsx", "utf8");
  const panel = await readFile("components/ProgressionPanel.tsx", "utf8");
  const chart = await readFile("components/SeasonalProgressionChart.tsx", "utf8");
  const score = await readFile("components/CheaterScore.tsx", "utf8");
  const dictionary = await readFile("lib/i18n/dictionary.ts", "utf8");

  const progression = profile.indexOf("<ProgressionPanel");
  const cheatingRisk = profile.indexOf("<CheaterScore");
  const radar = profile.indexOf("<PlayerRadarComparison");
  assert.ok(progression > 0 && cheatingRisk > progression && radar > cheatingRisk);
  assert.match(profile, /mode === "regular" && \(\s*<div id="progression"[\s\S]*?<ProgressionPanel/);
  assert.match(profile, /<section id="risk"[\s\S]*?<h2 className="section-heading mb-3">\{t\("cheater\.heading"\)\}<\/h2>[\s\S]*?<CheaterScore/);
  assert.doesNotMatch(score, /section-kicker">\{t\("cheater\.heading"\)\}/);
  assert.match(profile, /<ProgressionPanel[\s\S]*?mode="regular"[\s\S]*?cycleId="persistent"/);
  assert.match(profile, /progressionRisk=\{mode === "regular" \? progressionRisk : null\}/);

  assert.match(panel, /fetch\(`\/api\/progression\?\$\{params\}`/);
  for (const parameter of [
    "mode,",
    "cycle: cycleId",
    "aid: String(aid)",
    "kind,",
  ]) {
    assert.ok(panel.includes(parameter), `missing progression parameter: ${parameter}`);
  }
  assert.doesNotMatch(panel, /dimension|center: String/);
  assert.match(panel, /\["cumulative", "tempo", "form"\]/);
  assert.match(panel, /role="status"/);
  assert.match(panel, /history\.ready \? "progression\.ready" : "progression\.collecting"/);
  assert.match(panel, /result\.history\?\.ready && validRisk\(result\.risk\) \? result\.risk : null/);
  assert.doesNotMatch(panel, /kind === "cumulative"[\s\S]*?onRiskChange/);
  assert.doesNotMatch(panel, /Promise\.all/);
  assert.match(panel, /setSeries\(\(current\) => \(\{ \.\.\.current, \[kind\]: result \}\)\)/);
  assert.match(panel, /loadKind\("cumulative"\)\.finally[\s\S]*?loadKind\("tempo"\)[\s\S]*?loadKind\("form"\)/);
  assert.match(panel, /successfulRequests === 0 && completedRequests < PROGRESSION_KINDS\.length/);
  assert.match(panel, /successfulRequests === 0 && completedRequests === PROGRESSION_KINDS\.length/);
  assert.match(panel, /if \(controller\.signal\.aborted\) return/);
  assert.match(panel, /hasCumulative && series\.cumulative/);
  assert.match(panel, /hasTempo && series\.tempo/);
  assert.match(panel, /hasForm && series\.form/);
  assert.doesNotMatch(panel, /history\?\.ready && series\./);
  assert.match(chart, /point\.pmcRaids/);
  assert.match(chart, /raidTicks\(bounds\.minDay, bounds\.maxDay\)/);
  assert.match(chart, /axisPoints\(displayedPointsFor\(key\)\)/);
  assert.match(chart, /areaPath\(displayedPointsFor\("nearby"\), bounds\)/);
  assert.match(chart, /chartPath\(axisPoints\(displayedPointsFor\(key\)\), bounds/);
  assert.match(chart, /\{displayedPointsFor\(key\)\.map\(\(point\) =>/);
  assert.match(chart, /moscowDate\(point\.date\)/);
  assert.match(chart, /point\.raidMin != null && point\.raidMax != null/);
  assert.match(chart, /progression\.pointTipRange/);
  assert.match(dictionary, /"progression\.series\.overall": "Median PvP player"/);
  assert.match(dictionary, /"progression\.series\.overall": "Медианный игрок PvP"/);
  assert.match(dictionary, /"progression\.pointTipRange":/);
  assert.doesNotMatch(`${panel}\n${chart}`, /observationDay|Observation day|День наблюдения/);
  assert.doesNotMatch(panel, /seasonal-risk data-panel/);

  assert.match(score, /progressionRisk\?: ProgressionRiskPayload \| null/);
  assert.match(score, /progressionRisk \? Math\.round\(progressionRisk\.combined\) : result\.score/);
  assert.match(score, /progressionRisk\.staticContribution/);
  assert.match(score, /progressionRisk\.reasons\.map/);
});

test("progression APIs keep Seasonal queries on the configured active cycle", async () => {
  const general = await readFile("app/api/progression/route.ts", "utf8");
  const legacy = await readFile("app/api/seasonal/progression/route.ts", "utf8");
  assert.match(general, /loadSeasonalCycleConfig\(\)\?\.cycleId !== input\.cycleId/);
  assert.match(legacy, /loadSeasonalCycleConfig\(\)\?\.cycleId !== input\.cycleId/);
});

test("progression uses a five-hour shared bundle cache keyed without kind", async () => {
  const cache = await readFile("lib/seasonal/progression-cache.ts", "utf8");
  const flight = await readFile("lib/seasonal/progression-flight.ts", "utf8");
  const database = await readFile("lib/seasonal/progression-db.ts", "utf8");
  const general = await readFile("app/api/progression/route.ts", "utf8");
  const legacy = await readFile("app/api/seasonal/progression/route.ts", "utf8");

  assert.match(cache, /unstable_cache\(/);
  assert.match(cache, /PROGRESSION_CACHE_TTL_SECONDS = 18_000/);
  assert.match(cache, /\["progression-bundle-v2"\]/);
  assert.match(cache, /async \(\s*mode: ProgressionMode,\s*cycleId: string,\s*aid: number,/);
  assert.doesNotMatch(cache, /kind: ProgressionKind/);
  assert.match(cache, /throw new UncacheableProgressionResult\("unavailable"\)/);
  assert.match(cache, /throw new UncacheableProgressionResult\("not-found"\)/);
  assert.match(cache, /public, max-age=60, s-maxage=18000, stale-while-revalidate=300/);
  assert.match(cache, /singleFlight\(\s*inFlightProgressionBundles,\s*progressionFlightKey\(mode, cycleId, aid\)/);
  assert.match(flight, /load\(\)\.finally/);
  assert.match(flight, /inFlight\.delete\(key\)/);

  assert.match(database, /getProgressionBundleQuery/);
  assert.match(database, /PROGRESSION_KINDS\.map/);
  assert.match(database, /mergeProgressionBundle/);
  assert.equal(
    (database.match(/await details\(/g) ?? []).length,
    2,
    "shared details should run once in each storage implementation, not once per kind",
  );
  for (const route of [general, legacy]) {
    assert.match(route, /getCachedProgressionBundle\(input\.mode, input\.cycleId, input\.aid\)/);
    assert.match(route, /result\.bundle\[input\.kind\]/);
    assert.match(route, /"Cache-Control": PROGRESSION_CACHE_CONTROL/);
    assert.match(route, /function errorResponse\(error: string, status: number\)/);
    assert.match(route, /\{ status, headers: \{ "Cache-Control": "no-store" \} \}/);
    assert.doesNotMatch(route, /NextResponse\.json\(\{ error:/);
  }
});

test("regular average mounts median raid progression and cumulative tooltips include XP level", async () => {
  const canonical = await readFile("app/average/[mode]/page.tsx", "utf8");
  const average = await readFile("app/average/page.tsx", "utf8");
  const progression = await readFile("components/RegularAverageProgression.tsx", "utf8");
  const chart = await readFile("components/SeasonalProgressionChart.tsx", "utf8");
  const route = await readFile("app/api/progression/average/route.ts", "utf8");
  const dictionary = await readFile("lib/i18n/dictionary.ts", "utf8");

  assert.match(canonical, /mode === "regular"[\s\S]*?getPlayerLevels\(\)/);
  assert.match(canonical, /levelBands=\{cumulativeLevelBands\(levels\)\}/);
  assert.match(average, /mode === "regular" && levelBands\.length > 0/);
  assert.match(average, /<RegularAverageProgression levelBands=\{levelBands\} \/>/);
  assert.ok(
    average.indexOf("<RegularAverageProgression") < average.indexOf('t("average.fullMetrics")'),
    "regular progression should render before the full metric set",
  );
  assert.match(progression, /fetch\("\/api\/progression\/average"/);
  assert.equal((progression.match(/averageOnly/g) ?? []).length, 3);
  assert.equal((progression.match(/mode="regular"/g) ?? []).length, 3);
  assert.match(chart, /levelAtExperience\(point\.value, levelBands\)/);
  assert.match(chart, /spacedLevelLabels\(/);
  assert.match(chart, /progression\.xpLevelValue/);
  assert.match(chart, /aria-label=\{label\}/);
  assert.match(route, /getRegularProgressionAverage\(\)/);
  assert.match(route, /"Cache-Control": "public, max-age=60"/);
  assert.match(dictionary, /"progression\.xpLevelValue": "XP \{xp\} · Level \{level\}"/);
  assert.match(dictionary, /"progression\.xpLevelValue": "опыт: \{xp\} · уровень \{level\}"/);
});
