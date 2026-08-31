import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

let arenaUiModule;
async function loadArenaUi() {
  if (arenaUiModule) return arenaUiModule;
  const compilerOptions = {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  };
  const typesUrl = `data:text/javascript,${encodeURIComponent(ts.transpileModule(read("types/arena.ts"), { compilerOptions }).outputText)}`;
  const source = read("components/arena-ui.ts").replaceAll("@/types/arena", typesUrl);
  const moduleUrl = `data:text/javascript,${encodeURIComponent(ts.transpileModule(source, { compilerOptions }).outputText)}`;
  arenaUiModule = await import(moduleUrl);
  return arenaUiModule;
}

let arenaRangeModule;
async function loadArenaRange() {
  if (arenaRangeModule) return arenaRangeModule;
  const compilerOptions = {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  };
  const source = read("lib/arena/average-range.ts");
  const moduleUrl = `data:text/javascript,${encodeURIComponent(ts.transpileModule(source, { compilerOptions }).outputText)}`;
  arenaRangeModule = await import(moduleUrl);
  return arenaRangeModule;
}

let rangeSliderModule;
async function loadRangeSlider() {
  if (rangeSliderModule) return rangeSliderModule;
  const compilerOptions = {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
    importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
  };
  const reactUrl = `data:text/javascript,${encodeURIComponent("export const useRef = (value) => ({ current: value }); export const useEffect = (effect) => effect();")}`;
  const jsxUrl = `data:text/javascript,${encodeURIComponent("export const jsx = (type, props) => ({ type, props }); export const jsxs = jsx;")}`;
  const source = ts.transpileModule(read("components/RangeSlider.tsx"), { compilerOptions }).outputText
    .replaceAll('"react"', JSON.stringify(reactUrl))
    .replaceAll('"react/jsx-runtime"', JSON.stringify(jsxUrl));
  const moduleUrl = `data:text/javascript,${encodeURIComponent(source)}`;
  rangeSliderModule = await import(moduleUrl);
  return rangeSliderModule;
}

test("Arena UI keeps the five modes in a fixed sequential order", () => {
  const average = read("components/ArenaAverage.tsx");
  const profile = read("components/ArenaPlayer.tsx");
  const arenaTypes = read("types/arena.ts");
  const dictionary = read("lib/i18n/dictionary.ts");
  for (const mode of ["teamFight", "lastHero", "checkpoint", "blastGang", "shootOutDuo"]) {
    assert.match(arenaTypes, new RegExp(`"${mode}"`));
    assert.match(dictionary, new RegExp(`arena\\.mode\\.${mode}`));
  }
  assert.match(average, /ARENA_MODE_KEYS/);
  assert.match(profile, /ARENA_MODE_KEYS/);
  assert.match(average, /ARENA_MODE_KEYS\.map/);
  const legacyStart = profile.indexOf("function ArenaLegacyIncomplete");
  const legacyEnd = profile.indexOf("function ArenaModeSection");
  const legacy = profile.slice(legacyStart, legacyEnd);
  assert.match(legacy, /ARENA_MODE_KEYS\.map/);
  assert.match(legacy, /arena\.mode\." \+ mode/);
  assert.match(legacy, /arena\.profile\.legacyModeIncomplete/);
  assert.doesNotMatch(legacy, /ArenaModeComparison/);
});

test("Arena presentation preserves nullable values and namespaced filters", () => {
  const utility = read("components/arena-ui.ts");
  const average = read("components/ArenaAverage.tsx");
  const profile = read("components/ArenaPlayer.tsx");
  const risk = read("components/ArenaRiskPanel.tsx");
  assert.match(utility, /value === null \|\| value === undefined/);
  assert.match(utility, /return legacy \?\? null/);
  assert.match(average, /arena_\$\{mode\}_/);
  assert.match(average, /new AbortController\(\)/);
  assert.match(average, /function filterIsInvalid/);
  assert.match(average, /if \(invalid\)/);
  assert.match(average, /DEFAULT_MIN_MATCHES = "10"/);
  assert.match(profile, /body\.capture\?\.status === "refresh_failed"/);
  assert.match(profile, /throw new Error\(t\("player\.refreshStatus\.error"\)\)/);
  assert.match(risk, /const RISK_METRICS = \["kd_ratio", "win_rate", "kills_per_match", "damage_per_match"\]/);
  assert.doesNotMatch(risk.slice(risk.indexOf("const RISK_METRICS"), risk.indexOf("const TIER_COLOR")), /headshot_rate/);
  assert.match(risk, /scope === "overall"/);
  assert.match(risk, /\.overall \?\? null/);
  assert.match(risk, /viewBox="0 0 320 170"/);
});

test("Arena profile reuses the PvP shell and shows one selected mode", () => {
  const profile = read("components/ArenaPlayer.tsx");
  const account = read("components/ArenaAccountCard.tsx");
  assert.match(profile, /<ProfileSectionNav[\s\S]*?<ProfileHeader/);
  assert.match(profile, /<ProfileHeader[\s\S]*?mode="arena"/);
  assert.match(profile, /profile\.section\.overview/);
  assert.match(profile, /profile\.section\.risk/);
  assert.match(profile, /profile\.section\.comparison/);
  assert.match(profile, /arena\.section\.modes/);
  assert.doesNotMatch(profile, /profile\.section\.(?:progression|statistics|achievements|mastering|skills)/);
  assert.equal((account.match(/<StatCard/g) ?? []).length, 4);
  assert.match(account, /arena\.account\.hours/);
  assert.match(account, /arena\.counter\.matches/);
  assert.match(account, /arena\.counter\.kills/);
  assert.match(account, /arena\.metric\.win_rate/);
  assert.doesNotMatch(account, /arena\.metric\.kd_ratio/);
  assert.match(profile, /function mostPlayedMode/);
  assert.match(profile, /arenaModeFromUrl/);
  assert.match(profile, /className="arena-mode-picker"/);
  assert.match(profile, /key=\{selectedMode\}/);
  assert.match(profile, /mode=\{selectedMode\}/);
  assert.match(profile, /favorite=\{comparedFavorite\}/);
  assert.match(profile, /scope="overall"/);
});

test("Arena histogram keeps full context, matches PvP bar sizing, and defers range requests", async () => {
  const average = read("components/ArenaAverage.tsx");
  const slider = read("components/RangeSlider.tsx");
  assert.match(average, /function contextRequestFor/);
  assert.match(average, /dimension: ArenaDimension = "matches"/);
  assert.match(average, /const \[rangeContext, setRangeContext\]/);
  assert.match(average, /const chartContext = rangeContext && matchesContext\(rangeContext, mode, statistic, filter\.dimension\) \? rangeContext : null/);
  assert.match(average, /contextRequestFor\(mode, statistic, filter\.dimension\)/);
  assert.match(average, /result=\{chartContext\}/);
  assert.doesNotMatch(average, /result=\{currentResult\}/);
  assert.match(average, /buildNumericHistogram/);
  assert.match(average, /function buildArenaHistogramBuckets/);
  assert.match(average, /const fitBins = chartWidth > 0/);
  assert.match(average, /ARENA_BAR_MIN_PX \+ ARENA_BAR_GAP_PX/);
  assert.match(average, /const buckets = result \? buildArenaHistogramBuckets\(result\.buckets, metric, fitBins\) : \[\]/);
  assert.match(average, /arenaBucketPosition\(buckets, domain, value, edge, discrete, chartWidth, ARENA_BAR_GAP_PX\)/);
  assert.match(average, /arenaBucketValueAtPosition\(buckets, domain, position, edge, discrete, chartWidth, ARENA_BAR_GAP_PX\)/);
  assert.match(average, /ref=\{chartRef\}/);
  assert.match(average, /minVisualGap=\{chartWidth > 0 \? 20 \/ chartWidth : 0\}/);
  assert.match(average, /<RangeSlider/);
  assert.match(average, /average\.rangeFrom/);
  assert.match(average, /average\.rangeTo/);
  assert.match(average, /average-chart-toolbar/);
  assert.match(average, /chart-panel data-panel/);
  assert.match(average, /className="overflow-x-auto"/);
  assert.doesNotMatch(average, /min-w-\[34rem\]|minWidth: `max\(34rem/);
  assert.match(average, /ref=\{chartRef\} className="chart-panel data-panel mt-4"/);
  assert.match(average, /className="flex h-full min-w-\[26px\] flex-1 flex-col items-center justify-end"/);
  assert.match(average, /className="min-w-\[26px\] flex-1 text-center text-\[9px\]/);
  assert.doesNotMatch(average, /CompactDetails|arena\.average\.coverageDetails|arena\.average\.coverage/);
  assert.match(average, /const visibleRange/);
  assert.match(average, /filter\.dimension === "matches" && low === domain\.min/);
  assert.match(average, /value=\{draftRange\[field\] \|\|/);
  assert.doesNotMatch(average, /arena\.average\.metricSample/);
  assert.match(average, /const \[draftRange, setDraftRange\]/);
  assert.match(average, /onChange=\{setRange\}/);
  assert.match(average, /onChangeComplete=\{commitRange\}/);
  assert.match(average, /onBlur=\{\(\) => commitRange\(\)\}/);
  assert.doesNotMatch(average, /<details/);
  assert.match(slider, /onChangeComplete\?: \(low: number, high: number\) => void/);
  assert.match(slider, /onPointerDown=\{onChangeComplete \? capturePointer : undefined\}/);
  assert.match(slider, /onPointerUp=\{onChangeComplete \? releasePointer : undefined\}/);
  assert.match(slider, /onKeyUp=\{onChangeComplete \? complete : undefined\}/);

  const { arenaBucketPosition, arenaBucketValueAtPosition, arenaHistogramSlice, arenaRangeSelection } = await loadArenaRange();
  const matchDomain = { min: 10, max: 958 };
  const fullMatches = arenaRangeSelection(matchDomain, 10, null);
  assert.deepEqual(fullMatches, { low: 10, high: 958 });
  assert.deepEqual(
    arenaHistogramSlice({ min: 0, max: 25 }, fullMatches, matchDomain, true),
    { left: 0, width: 100 },
  );
  const narrowMatches = arenaRangeSelection(matchDomain, 50, 100);
  assert.equal(arenaHistogramSlice({ min: 200, max: 225 }, narrowMatches, matchDomain, true).width, 0);
  assert.deepEqual(arenaHistogramSlice({ min: 50, max: 75 }, narrowMatches, matchDomain, true), { left: 0, width: 100 });
  assert.deepEqual(arenaRangeSelection({ min: 0, max: 2195 }, 0, 1), { low: 0, high: 1 });
  assert.deepEqual(arenaRangeSelection({ min: 0, max: 2195 }, 10_000, 11_000), { low: 2195, high: 2195 });

  const sparseMatches = [{ min: 0, max: 25 }, { min: 25, max: 75 }, { min: 100, max: 200 }, { min: 250, max: null }];
  const sparseBounds = { min: 10, max: 300 };
  const width = 400;
  const gap = 10;
  assert.equal(arenaBucketPosition(sparseMatches, sparseBounds, 10, "low", true, width, gap), 0);
  assert.equal(arenaBucketPosition(sparseMatches, sparseBounds, 300, "high", true, width, gap), 1);
  assert.ok(arenaBucketPosition(sparseMatches, sparseBounds, 300, "low", true, width, gap) < 1);
  assert.equal(arenaBucketPosition(sparseMatches, sparseBounds, 99, "high", true, width, gap), 195 / 400);
  assert.equal(arenaBucketPosition(sparseMatches, sparseBounds, 100, "low", true, width, gap), 205 / 400);
  assert.equal(arenaBucketValueAtPosition(sparseMatches, sparseBounds, 195 / 400, "high", true, width, gap), 74);
  assert.equal(arenaBucketValueAtPosition(sparseMatches, sparseBounds, 200 / 400, "high", true, width, gap), 74);
  assert.equal(arenaBucketValueAtPosition(sparseMatches, sparseBounds, 200 / 400, "low", true, width, gap), 100);

  const sparseHours = [{ min: 0, max: 50 }, { min: 50, max: 100 }, { min: 200, max: null }];
  const hourBounds = { min: 0, max: 220 };
  const hourWidth = 300;
  const hourGap = 6;
  const hourPadding = (hourBounds.max - hourBounds.min) / 10_000;
  assert.equal(arenaBucketPosition(sparseHours, hourBounds, 0, "low", false, hourWidth, hourGap), 0);
  assert.equal(arenaBucketPosition(sparseHours, hourBounds, 220, "high", false, hourWidth, hourGap), 1);
  assert.ok(arenaBucketPosition(sparseHours, hourBounds, 220, "low", false, hourWidth, hourGap) < 1);
  assert.equal(arenaBucketPosition(sparseHours, hourBounds, 150, "high", false, hourWidth, hourGap), 198 / 300);
  assert.equal(arenaBucketPosition(sparseHours, hourBounds, 150, "low", false, hourWidth, hourGap), 204 / 300);
  assert.ok(Math.abs(arenaBucketValueAtPosition(sparseHours, hourBounds, 198 / 300, "high", false, hourWidth, hourGap) - (100 - hourPadding)) < 1e-9);
  assert.equal(arenaBucketValueAtPosition([], hourBounds, 0.5, "low", false, hourWidth, hourGap), 0);
  assert.equal(arenaBucketValueAtPosition([], hourBounds, 0.5, "high", false, hourWidth, hourGap), 220);
});

test("RangeSlider only completes an Arena draft after interaction ends", async () => {
  const { default: RangeSlider } = await loadRangeSlider();
  const changes = [];
  const completions = [];
  const tree = RangeSlider({
    min: 0, max: 100, low: 0, high: 100, lowLabel: "From", highLabel: "To",
    onChange: (low, high) => changes.push([low, high]),
    onChangeComplete: (low, high) => completions.push([low, high]),
  });
  const [lowInput] = tree.props.children.filter((child) => child.type === "input");
  lowInput.props.onChange({ target: { value: "2500" } });
  lowInput.props.onChange({ target: { value: "4000" } });
  assert.deepEqual(changes, [[25, 100], [40, 100]]);
  assert.deepEqual(completions, []);

  const captured = new Set();
  const pointer = {
    pointerId: 1,
    currentTarget: {
      setPointerCapture: (id) => captured.add(id),
      hasPointerCapture: (id) => captured.has(id),
      releasePointerCapture: (id) => captured.delete(id),
    },
  };
  lowInput.props.onPointerDown(pointer);
  lowInput.props.onPointerUp(pointer);
  assert.deepEqual(completions, [[40, 100]]);

  const normalChanges = [];
  const normalTree = RangeSlider({
    min: 0, max: 100, low: 0, high: 100, lowLabel: "From", highLabel: "To",
    onChange: (low, high) => normalChanges.push([low, high]),
  });
  const [normalLow] = normalTree.props.children.filter((child) => child.type === "input");
  assert.equal(normalLow.props.onPointerDown, undefined);
  assert.equal(normalLow.props.onPointerUp, undefined);
  assert.equal(normalLow.props.onKeyUp, undefined);
  normalLow.props.onChange({ target: { value: "5000" } });
  assert.deepEqual(normalChanges, [[50, 100]]);
});

test("Arena average uses one selected mode and validates optional population counts", async () => {
  const average = read("components/ArenaAverage.tsx");
  assert.match(average, /const \[selectedMode, setSelectedMode\] = useState<ArenaModeKey>\("teamFight"\)/);
  assert.match(average, /const \[overview, setOverview\]/);
  assert.match(average, /className="arena-mode-picker"/);
  assert.match(average, /aria-pressed=\{mode === selectedMode\}/);
  assert.match(average, /key=\{selectedMode\}/);
  assert.match(average, /setSelectedMode\(readSelectedMode\(\)\)/);

  const { arenaAveragePopulation } = await loadArenaUi();
  const playedAccounts = {
    teamFight: 402,
    lastHero: 458,
    checkpoint: 468,
    blastGang: 282,
    shootOutDuo: 165,
  };
  assert.deepEqual(arenaAveragePopulation({ population: { scannedAccounts: 500, playedAccounts } }), {
    scannedAccounts: 500,
    playedAccounts,
  });
  assert.equal(arenaAveragePopulation({ population: { scannedAccounts: 500, playedAccounts: { ...playedAccounts, teamFight: "402" } } }), null);
  assert.equal(arenaAveragePopulation({}), null);
});

test("Arena waits to read URL filters until after hydration", () => {
  const average = read("components/ArenaAverage.tsx");
  assert.match(average, /const \[statistic, setStatistic\] = useState<ArenaStatistic>\("trimmed_mean"\)/);
  assert.match(average, /const \[filters, setFilters\] = useState<Record<ArenaModeKey, ArenaFilterState>>\(defaultFilters\)/);
  assert.match(average, /const \[urlReady, setUrlReady\] = useState\(false\)/);
  assert.match(average, /readUrl\(\);\s+setUrlReady\(true\)/);
  assert.match(average, /if \(!ready\) return;/);
  assert.doesNotMatch(average, /useState<ArenaStatistic>\(readStatistic\)/);
});

test("Arena averages reuse the common portrait header without a profile-period selector", () => {
  const header = read("components/AveragePageHeader.tsx");
  const average = read("components/ArenaAverage.tsx");
  assert.match(average, /<AveragePageHeader[\s\S]*current="arena"[\s\S]*onStatisticChange=\{changeStatistic\}/);
  assert.match(header, /<p className="page-kicker mt-7">\{t\("average\.summary"\)\}<\/p>/);
  assert.match(header, /<h1 className="page-title">\{t\("nav\.average"\)\}<\/h1>/);
  assert.match(header, /name="average-period"/);
  assert.match(header, /period !== undefined && onPeriodChange !== undefined/);
  assert.match(header, /current === "arena"[\s\S]*arena\.average\.statisticNote/);
  assert.doesNotMatch(average, /arena\.average\.(?:kicker|title|description|statisticNote)/);
});

test("Arena helpers execute the nullable and legacy normalization rules", async () => {
  const { finiteNumber, isArenaProfile, normalizeArenaMetrics, toArenaProfile } = await loadArenaUi();
  assert.equal(finiteNumber(null), null);
  assert.equal(finiteNumber(undefined), null);
  assert.equal(finiteNumber(0), 0);
  assert.deepEqual(normalizeArenaMetrics({ kd_ratio: 0, win_rate: null }), {
    kd_ratio: 0,
    win_rate: null,
    headshot_rate: null,
    kills_per_match: null,
    damage_per_match: null,
  });

  const normalized = toArenaProfile({
    aid: 17,
    nickname: "Zero",
    profileUpdatedAt: 1,
    fetchedAt: null,
    parserVersion: 2,
    overall: { source: "upstream", hours: null, counters: { matches: null, kills: 0 }, metrics: { kd_ratio: 0 } },
    modes: { teamFight: { mode: "teamFight", hours: null, counters: { matches: null, kills: 0 }, metrics: { kd_ratio: 0 } } },
  }, 17);
  assert.equal(normalized?.overall.counters.matches, null);
  assert.equal(normalized?.overall.counters.kills, 0);
  assert.equal(normalized?.modes.teamFight.metrics.kd_ratio, 0);
  assert.equal(normalized?.modes.teamFight.metrics.headshot_rate, null);

  const legacy = toArenaProfile({
    nickname: "Legacy",
    arena: {
      totalKills: 0,
      totalDeaths: 0,
      kdRatio: 0,
      modes: [{ key: "TeamFight", kills: 0, deaths: 0, kdRatio: 0 }],
    },
  }, 44);
  assert.equal(isArenaProfile({ modes: [{ key: "TeamFight" }] }), false);
  assert.equal(legacy?.modes.teamFight.counters.kills, 0);
  assert.equal(legacy?.modes.teamFight.counters.headshots, null);
  assert.equal(legacy?.overall.metrics.kd_ratio, 0);
});

test("Arena radar uses the PvP comparison scale and accessible interactions", () => {
  const compare = read("components/FavoritesCompare.tsx");
  const radar = read("components/ArenaRadar.tsx");
  const comparison = compare.slice(compare.indexOf("function ArenaComparisonTable"));
  assert.match(comparison, /ARENA_METRIC_KEYS\.map/);
  assert.doesNotMatch(comparison, /survivalRate|totalRaids|level|raids/);
  assert.match(compare, /isArenaProfile\(statsByFavorite\.get\(favoriteKey\(favorite\)\)\)/);
  assert.doesNotMatch(compare, /toArenaProfile\(statsByFavorite/);
  assert.match(radar, /ArenaOverallStats/);
  assert.match(radar, /Math\.atan\(Math\.log\(ratio\)\) \/ Math\.PI/);
  assert.match(radar, /const meanRatios = centerValues\.map\(\(value\) => value === null \? null : 1\)/);
  assert.match(radar, /onPointerEnter=/);
  assert.match(radar, /onFocus=/);
  assert.match(radar, /setPinnedAxis/);
  assert.match(radar, /event\.key !== "Escape"/);
  assert.match(radar, /className="sr-only"/);
  assert.doesNotMatch(radar, /overflow-x-auto/);
  assert.doesNotMatch(radar, /sampleShort/);
  assert.doesNotMatch(radar, /cursor-help/);
});
