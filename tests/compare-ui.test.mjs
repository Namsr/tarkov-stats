import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("global navigation points to compare and only marks its root active", async () => {
  const source = await readFile("components/AverageNavButton.tsx", "utf8");

  assert.match(source, /export default function CompareNavButton/);
  assert.match(source, /href="\/compare"/);
  assert.match(source, /const active = pathname === "\/compare" \|\| pathname === "\/compare\/"/);
  assert.doesNotMatch(source, /pathname\.startsWith\("\/compare"\)/);
  assert.match(source, /t\("nav\.compare"\)/);
});

test("average mode navigation uses population routes without renaming the page contract", async () => {
  const source = await readFile("components/ProfileModeSwitch.tsx", "utf8");

  assert.match(source, /page: "average" \| "player"/);
  assert.match(source, /page === "average" \? `\/population\/\$\{routeMode\}` : `\/player\/\$\{routeMode\}\/\$\{aid\}`/);
  assert.doesNotMatch(source, /\/average\/\$\{routeMode\}/);
});

test("population headers use the population label while retaining page average", async () => {
  const source = await readFile("components/AveragePageHeader.tsx", "utf8");

  assert.match(source, /import \{ usePathname \} from "next\/navigation"/);
  assert.match(source, /const isPopulation = pathname === "\/population" \|\| pathname\.startsWith\("\/population\/"\)/);
  assert.match(source, /<h1 className="page-title">\{t\("nav\.population"\)\}<\/h1>/);
  assert.match(source, /<h1 className="page-title">\{t\("nav\.average"\)\}<\/h1>/);
  assert.match(source, /<ProfileModeSwitch[\s\S]*page="average"/);
  assert.doesNotMatch(source, /page="population"/);
});

test("compare resolves one server-pinned scope and keeps both selections across mode changes", async () => {
  const [page, source, adapter] = await Promise.all([
    readFile("app/compare/page.tsx", "utf8"),
    readFile("components/ComparePage.tsx", "utf8"),
    readFile("lib/comparison-adapter.ts", "utf8"),
  ]);

  assert.match(page, /<ComparePage seasonalCycleId=\{seasonalCycleId\} \/>/);
  assert.match(adapter, /comparisonScopeFromSearchParams/);
  assert.match(adapter, /comparisonProfileRequestUrl/);
  assert.match(adapter, /comparisonCohortRequestUrl/);
  assert.match(source, /comparisonScopeFromSearchParams\(searchParams, seasonalCycleId \?\? null\)/);
  assert.match(source, /const scopeKey = scope \? `\$\{scope\.mode\}:\$\{scope\.cycleId\}:\$\{scope\.arenaMode\}` : ""/);
  assert.match(source, /<SegmentedRadio[\s\S]*name="compare-mode"/);
  assert.match(source, /const modeOptions = GAME_MODES[\s\S]*\.filter\(\(mode\) => seasonalCycleId \|\| mode !== "seasonal"\)/);
  assert.match(source, /params\.set\("mode", mode\)/);
  assert.match(source, /params\.set\(slot === "primary" \? "aid" : "vs", String\(aid\)\)/);
  assert.doesNotMatch(source, /params\.delete\("aid"\)|params\.delete\("vs"\)/);
  assert.match(source, /fixedMode=\{scope\.mode\}/);
  assert.equal((source.match(/cycleId=\{scope\.cycleId\}/g) ?? []).length >= 2, true);
});

test("seasonal comparison is fail-closed before profile or cohort endpoints", async () => {
  const source = await readFile("components/ComparePage.tsx", "utf8");

  assert.match(source, /if \(!scope \|\| aid === null\) \{[\s\S]*return;/);
  assert.match(source, /loadPlayerProfileResponse<unknown>\(comparisonProfileRequestUrl\(scope, aid\)/);
  assert.match(source, /loadAverageJson<unknown>\(requestUrl/);
  assert.match(source, /seasonal\.unavailableDescription/);
  assert.match(source, /\{!scope && \([\s\S]*seasonal\.unavailable/);
  assert.doesNotMatch(source, /scope\.mode === "seasonal"[\s\S]{0,200}loadAverageJson/);
});

test("seasonal stays hidden as an option without a pinned cycle while direct URLs remain fail-closed", async () => {
  const source = await readFile("components/ComparePage.tsx", "utf8");

  assert.match(source, /const modeOptions = GAME_MODES\s*\.filter\(\(mode\) => seasonalCycleId \|\| mode !== "seasonal"\)/);
  assert.match(source, /options=\{modeOptions\}/);
  assert.match(source, /const visibleMode: GameMode = GAME_MODES\.includes\(rawMode as GameMode\)/);
  assert.match(source, /value=\{scope\?\.mode \?\? visibleMode\}/);
  assert.match(source, /\{!scope && \([\s\S]*visibleMode === "seasonal" \? "seasonal\.unavailable"/);
});

test("compare renders the adapter-backed metric set for each scope", async () => {
  const [source, types] = await Promise.all([
    readFile("components/ComparePage.tsx", "utf8"),
    readFile("types/comparison.ts", "utf8"),
  ]);

  assert.match(source, /PERSISTENT_COMPARISON_METRIC_KEYS/);
  assert.match(source, /ARENA_COMPARISON_METRIC_KEYS/);
  assert.match(source, /const metricDefinitions = scope\?\.mode === "arena" \? METRICS\.arena : METRICS\.persistent/);
  assert.match(source, /key: "win_rate"/);
  assert.match(source, /key: "headshot_rate"/);
  assert.match(source, /key: "kills_per_match"/);
  assert.match(source, /key: "damage_per_match"/);
  assert.match(source, /valueA: profileValue\(primaryProfile, metric\.key\)/);
  assert.match(source, /valueB: profileValue\(secondaryProfile, metric\.key\)/);
  assert.match(source, /benchmark: benchmarkFor\(cohort, metric\.key\)/);
  assert.match(source, /if \(!benchmark \|\| benchmark\.count <= 0\) return null/);
  assert.match(source, /if \(!cohort\?\.percentiles\) return null/);
  assert.equal((types.match(/"pmc_kd_ratio"|"kills_per_raid"|"pmc_survival_rate"|"longest_win_streak"|"level"/g) ?? []).length >= 5, true);
});

test("arena and seasonal keep benchmarks but suppress percentile claims and columns", async () => {
  const [source, table, badge] = await Promise.all([
    readFile("components/ComparePage.tsx", "utf8"),
    readFile("components/ComparisonTable.tsx", "utf8"),
    readFile("components/PercentileBadge.tsx", "utf8"),
  ]);

  assert.match(source, /const supportsPercentiles = scope\?\.mode === "regular" \|\| scope\?\.mode === "pve"/);
  assert.match(source, /compare\.benchmarkOnly/);
  assert.match(source, /showPercentile=\{supportsPercentiles\}/);
  assert.match(source, /\{supportsPercentiles && \([\s\S]*compare-ranks-title/);
  assert.match(table, /showPercentile = true/);
  assert.match(table, /\{showPercentile && \([\s\S]*compare\.percentile/);
  assert.match(table, /compare\.tableCaptionNoPercentile/);
  assert.match(badge, /aria-label=\{t\("pct\.badge", \{ value \}\)\}/);
});

test("compare refreshes one selected slot directly and preserves its last good snapshot", async () => {
  const [source, button] = await Promise.all([
    readFile("components/ComparePage.tsx", "utf8"),
    readFile("components/RefreshButton.tsx", "utf8"),
  ]);

  assert.match(source, /const primary = useComparisonProfile[\s\S]*const secondary = useComparisonProfile/);
  assert.match(source, /comparisonProfileRequestUrl\(scope, aid, \{ refresh: true \}\)/);
  assert.match(source, /\{ force: true, signal: controller\.signal \}/);
  assert.match(source, /function captureStatus\([\s\S]*record\(record\(value\)\?\.capture\)[\s\S]*capture\?\.status/);
  const refresh = source.slice(
    source.indexOf("const refresh = useCallback"),
    source.indexOf("return { state, refresh }"),
  );
  assert.match(refresh, /if \(captureStatus\(body\) === "refresh_failed"\) throw new Error[\s\S]*const adapted = adaptComparisonProfile/);
  assert.match(refresh, /const adapted = adaptComparisonProfile[\s\S]*setState\(/);
  assert.match(source, /previous\.updatedAt !== next\.updatedAt \|\| previous\.profileSnapshot !== next\.profileSnapshot/);
  assert.match(source, /current\.scopeKey === scopeKey && current\.aid === aid/);
  assert.match(source, /<RefreshButton[\s\S]*direct/);
  assert.match(button, /direct = false/);
  assert.match(button, /direct \? \([\s\S]*<button[\s\S]*onClick=\{\(\) => void check\(\)\}/);
  assert.doesNotMatch(source, /tarkov\.dev/);
});

test("direct refresh supersedes an unfinished initial request for the same profile identity", async () => {
  const source = await readFile("components/ComparePage.tsx", "utf8");
  const hook = source.slice(
    source.indexOf("function useComparisonProfile"),
    source.indexOf("function useComparisonCohort"),
  );
  const effect = hook.slice(0, hook.indexOf("const refresh = useCallback"));
  const refresh = hook.slice(hook.indexOf("const refresh = useCallback"));

  assert.match(hook, /const requestGeneration = useRef\(0\)/);
  assert.match(hook, /const activeController = useRef<AbortController \| null>\(null\)/);
  assert.match(effect, /const generation = requestGeneration\.current \+ 1;[\s\S]*requestGeneration\.current = generation;[\s\S]*activeController\.current\?\.abort\(\);[\s\S]*comparisonProfileRequestUrl\(scope, aid\), \{ signal: controller\.signal \}/);
  assert.match(effect, /\.then[\s\S]*if \(!active\(\)\) return;[\s\S]*setState/);
  assert.match(refresh, /const generation = requestGeneration\.current \+ 1;[\s\S]*requestGeneration\.current = generation;[\s\S]*activeController\.current\?\.abort\(\);[\s\S]*\{ force: true, signal: controller\.signal \}/);
  assert.match(refresh, /catch \(error\) \{[\s\S]*\{ \.\.\.current, loading: false \}[\s\S]*throw error;/);
});

test("primary refresh bypasses cohort caches for the new profile revision while secondary refresh does not", async () => {
  const source = await readFile("components/ComparePage.tsx", "utf8");

  assert.match(source, /function profileRevision\([\s\S]*profileSnapshot[\s\S]*return `\$\{profile\.updatedAt \?\? "unknown"\}-\$\{\(hash >>> 0\)\.toString\(36\)\}`/);
  assert.match(source, /function cohortRevisionRequestUrl\([\s\S]*url\.searchParams\.set\("revision", revision\)/);
  assert.match(source, /revision\.current = \{ scopeKey, aid, value: nextRevision \}/);
  assert.match(source, /const currentRevision = revision\.current\?\.scopeKey === scopeKey && revision\.current\.aid === aid/);
  assert.match(source, /fetch\(cohortRevisionRequestUrl\(scope, aid, nextRevision\), \{\s*cache: "no-store",\s*signal: controller\.signal,/);
  assert.match(source, /const primary = useComparisonProfile\(scope, scopeKey, primaryAid, activeModeLabel, t, cohortController\.reload\)/);
  assert.match(source, /const secondary = useComparisonProfile\(scope, scopeKey, secondaryAid, activeModeLabel, t\)/);
  assert.match(source, /if \(active\(\)\) await onRefreshed\?\.\(next\)/);
});

test("profile and cohort generations isolate mode and player switches", async () => {
  const source = await readFile("components/ComparePage.tsx", "utf8");
  const profileHook = source.slice(
    source.indexOf("function useComparisonProfile"),
    source.indexOf("function useComparisonCohort"),
  );
  const cohortHook = source.slice(
    source.indexOf("function useComparisonCohort"),
    source.indexOf("function RankedMetricList"),
  );

  assert.match(source, /const scopeKey = scope \? `\$\{scope\.mode\}:\$\{scope\.cycleId\}:\$\{scope\.arenaMode\}` : ""/);
  for (const hook of [profileHook, cohortHook]) {
    assert.match(hook, /const requestGeneration = useRef\(0\)/);
    assert.match(hook, /return \(\) => \{\s*requestGeneration\.current \+= 1;\s*activeController\.current\?\.abort\(\);/);
    assert.match(hook, /generation === requestGeneration\.current && !controller\.signal\.aborted/);
  }
  assert.match(profileHook, /generation === requestGeneration\.current && current\.scopeKey === scopeKey && current\.aid === aid/);
  assert.match(cohortHook, /revisionIdentity\.current !== identity[\s\S]*revision\.current = null/);
  assert.match(source, /cohortState\.scopeKey === scopeKey && cohortState\.aid === primaryAid/);
});

test("compare uses scope-specific profile and population routes", async () => {
  const source = await readFile("components/ComparePage.tsx", "utf8");

  assert.match(source, /`\/player\/\$\{appRouteMode\(scope\.mode\)\}\/\$\{aid\}`/);
  assert.match(source, /scope\.mode === "seasonal" \? `\$\{base\}\?cycle=\$\{encodeURIComponent\(scope\.cycleId\)\}` : base/);
  assert.match(source, /`\/population\/\$\{appRouteMode\(scope\.mode\)\}`/);
  assert.match(source, /href=\{profileHref\(scope, aid\)\}/);
  assert.match(source, /href=\{populationHref\(scope\)\}/);
});

test("compare integrates the progression graph only for progression-capable scopes", async () => {
  const source = await readFile("components/ComparePage.tsx", "utf8");

  assert.match(source, /<CompareProgressionSection[\s\S]*mode=\{scope\.mode as 'regular'\|'pve'\|'seasonal'\}[\s\S]*cycleId=\{scope\.cycleId\}[\s\S]*primary=\{primaryProgression\}[\s\S]*secondary=\{secondaryProgression\}/);
  assert.match(source, /scope\.mode === "arena"[\s\S]*compare\.progressionArenaUnavailable/);
  assert.match(source, /nickname: primaryProfile\?\.nickname\?\.trim\(\) \|\| `#\$\{primaryAid\}`/);
  assert.match(source, /updatedAt: primaryCurrent\?\.data\?\.updatedAt \?\? null/);
});

test("comparison navigation, graph state, and honest capability copy are bilingual", async () => {
  const dictionary = await readFile("lib/i18n/dictionary.ts", "utf8");

  assert.match(dictionary, /"compare\.benchmarkOnly": "The cohort benchmark is available for this mode; percentiles are not\."/);
  assert.match(dictionary, /"compare\.benchmarkOnly": "Для этого режима доступен эталон когорты, но процентили недоступны\."/);
  assert.match(dictionary, /"compare\.progressionArenaUnavailable": "Arena progression comparison is unavailable because Arena has no progression history\."/);
  assert.match(dictionary, /"compare\.progressionArenaUnavailable": "Сравнение прогрессии в Арене недоступно: у Арены нет истории прогрессии\."/);
  assert.match(dictionary, /"compare\.tableCaptionNoPercentile": "Exact player values and cohort benchmark"/);
  assert.match(dictionary, /"compare\.tableCaptionNoPercentile": "Точные значения игроков и эталон когорты"/);
  assert.match(dictionary, /"player\.refreshDirectHint": "Check the public profile API for a newer snapshot now\."/);
  assert.match(dictionary, /"player\.refreshDirectHint": "Сразу запросить публичный API профиля и проверить, есть ли новый снимок\."/);
});
