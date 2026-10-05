import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dict } from "../lib/i18n/dictionary.ts";
import { previewRatio } from "../lib/leaderboard-preview.ts";

test("average captions render both languages, both directions, equality and zero baselines", async () => {
  const require = createRequire(import.meta.url);
  const source = await readFile("components/AverageComparison.tsx", "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  for (const lang of ["ru", "en"]) {
    const exports = {};
    const mockedRequire = id => id === "@/lib/i18n/context" ? { useI18n: () => ({ lang,
      t: (key, vars) => dict[lang][key].replace(/\{(\w+)\}/g, (_, name) => vars[name]),
    }) } : id === "@/lib/leaderboard-preview" ? { previewRatio } : require(id);
    new Function("require", "exports", compiled)(mockedRequire, exports);
    const render = (value, average) => renderToStaticMarkup(createElement(exports.default, { value, average }));
    assert.match(render(2, 1), /data-direction="above"/);
    assert.match(render(1, 2), /data-direction="below"/);
    assert.ok(render(2, 1).includes(lang === "ru" ? "Выше среднего в 2×" : "2× above average"));
    assert.ok(render(1, 2).includes(lang === "ru" ? "Ниже среднего в 2×" : "2× below average"));
    assert.ok(render(0, 0).includes(dict[lang]["common.atAverage"]));
    for (const [value, average, key] of [[2, 0, "common.aboveAverage"], [0, 2, "common.belowAverage"]]) {
      const html = render(value, average);
      assert.ok(html.includes(dict[lang][key]));
      assert.doesNotMatch(html, /Infinity|NaN|×/);
    }
    assert.equal(render(null, 2), "");
    assert.equal(render(2, null), "");
  }
});

async function riskPollingHarness({ score = 16, responseIdentity, existingRisk, mode = "seasonal", withView = true } = {}) {
  const source = (await readFile("components/ComparePage.tsx", "utf8")).replace(/\r\n/g, "\n");
  const start = source.indexOf("  useEffect(() => {\n    const data = state.data;");
  const end = source.indexOf("  const refresh = useCallback", start);
  assert.ok(start > 0 && end > start);
  const compiled = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const scope = { mode, cycleId: "s1", arenaMode: null }, scopeKey = `${mode}:s1:null`, aid = 42;
  const identity = { aid, mode, cycleId: "s1" };
  const payload = { identity, risk: existingRisk ?? null, ...(withView ? { viewModel: { identity, risk: existingRisk ?? null } } : {}) };
  let current = { aid, scopeKey, data: { profile: {}, payload } };
  const state = current, generation = { current: 1 }, timers = [], requests = [];
  let cleanup;
  const run = new Function("useEffect", "state", "scope", "scopeKey", "aid", "requestGeneration", "record", "comparisonDossier", "storedProfile", "setState", "fetch", "setTimeout", "clearTimeout", compiled);
  run(callback => { cleanup = callback(); }, state, scope, scopeKey, aid, generation,
    value => value && typeof value === "object" ? value : null,
    (_, __, body) => ({ risk: body.viewModel?.risk ?? body.risk }),
    (profile, body) => ({ profile, payload: body }),
    update => { current = update(current); },
    async (url, init) => {
      requests.push({ url, init });
      return { ok: true, json: async () => ({ identity: responseIdentity ?? identity, risk: requests.length === 1 ? null : { score } }) };
    },
    callback => { timers.push(callback); return callback; },
    timer => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); });
  return { requests, generation, state: () => current, cleanup: () => cleanup?.(),
    tick: async () => { timers.shift()?.(); await new Promise(setImmediate); } };
}

test("deferred comparison risk replaces both payload risk fields and preserves a zero score", async () => {
  for (const score of [16, 0]) {
    const poll = await riskPollingHarness({ score });
    await poll.tick();
    assert.equal(poll.state().data.payload.risk, null);
    await poll.tick();
    assert.equal(poll.state().data.payload.risk.score, score);
    assert.equal(poll.state().data.payload.viewModel.risk.score, score);
    assert.equal(poll.requests.length, 2);
    assert.equal(poll.requests[0].url, "/api/player/risk?aid=42&mode=seasonal&cycle=s1");
    poll.cleanup();
  }
});

test("comparison risk polling rejects another account, mode or cycle and cancels superseded loads", async () => {
  for (const change of [{ aid: 99 }, { mode: "pve" }, { cycleId: "s2" }]) {
    const poll = await riskPollingHarness({ responseIdentity: { aid: 42, mode: "seasonal", cycleId: "s1", ...change } });
    await poll.tick();
    await poll.tick();
    assert.equal(poll.state().data.payload.risk, null);
    poll.cleanup();
  }
  const superseded = await riskPollingHarness();
  await superseded.tick();
  superseded.generation.current++;
  await superseded.tick();
  assert.equal(superseded.requests.length, 1);
  assert.equal(superseded.state().data.payload.risk, null);
  superseded.cleanup();
  assert.equal(superseded.requests[0].init.signal.aborted, true);
  const cancelled = await riskPollingHarness();
  cancelled.cleanup();
  await cancelled.tick();
  assert.equal(cancelled.requests.length, 0);
});

test("comparison risk polling skips available zero risk and Arena and supports regular payloads", async () => {
  for (const options of [{ existingRisk: { score: 0 } }, { mode: "arena" }]) {
    const poll = await riskPollingHarness(options);
    await poll.tick();
    assert.equal(poll.requests.length, 0);
    poll.cleanup();
  }
  const regular = await riskPollingHarness({ mode: "regular", withView: false });
  await regular.tick();
  await regular.tick();
  assert.equal(regular.state().data.payload.risk.score, 16);
  assert.equal(regular.state().data.payload.viewModel, undefined);
  regular.cleanup();
});

test("comparison polls deferred risk for each persistent profile and cancels obsolete requests", async () => {
  const source = await readFile("components/ComparePage.tsx", "utf8");
  assert.match(source, /scope.mode === "arena"/);
  assert.match(source, /comparisonDossier\(scope, aid, data.payload\)\?\.risk/);
  assert.match(source, /fetch\(`\/api\/player\/risk\?\$\{params\}`, \{ cache: "no-store", signal: controller.signal \}/);
  assert.match(source, /identity\?\.aid !== aid \|\| identity.mode !== scope.mode \|\| identity.cycleId !== scope.cycleId/);
  assert.match(source, /current.data === data && current.scopeKey === scopeKey && current.aid === aid/);
  assert.match(source, /viewModel: \{ \.\.\.viewModel, risk: body.risk \}/);
  assert.match(source, /clearTimeout\(timer\); controller.abort\(\)/);
});

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

test("compare renders full dossiers for the selected scope", async () => {
  const source = await readFile("components/ComparePage.tsx", "utf8");
  const dossiers = await readFile("components/ComparisonDossiers.tsx", "utf8");
  assert.match(source, /<ComparisonDossiers/);
  assert.match(source, /primaryPayload=\{primaryCurrent\?\.data\?\.payload\}/);
  assert.match(source, /secondaryPayload=\{secondaryCurrent\?\.data\?\.payload\}/);
  for (const metric of ["kd_ratio", "win_rate", "headshot_rate", "kills_per_match", "damage_per_match"]) assert.ok(dossiers.includes(metric));
  for (const section of ["achievements", "skills", "mastering", "risk", "arena-overview"]) assert.ok(dossiers.includes(section));
});

test("dossiers show player medians without percentile badges", async () => {
  const source = await readFile("components/ComparisonDossiers.tsx", "utf8");
  assert.doesNotMatch(source, /PercentileBadge/);
  assert.match(source, /t\("compare\.playerMedian"\)/);
  assert.match(source, /state\.data\?\.quality === "sufficient"/);
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

test("each profile refresh reloads its own cohort for the new revision", async () => {
  const source = await readFile("components/ComparePage.tsx", "utf8");

  assert.match(source, /function profileRevision\([\s\S]*profileSnapshot[\s\S]*return `\$\{profile\.updatedAt \?\? "unknown"\}-\$\{\(hash >>> 0\)\.toString\(36\)\}`/);
  assert.match(source, /function cohortRevisionRequestUrl\([\s\S]*url\.searchParams\.set\("revision", revision\)/);
  assert.match(source, /revision\.current = \{ scopeKey, aid, value: nextRevision \}/);
  assert.match(source, /const currentRevision = revision\.current\?\.scopeKey === scopeKey && revision\.current\.aid === aid/);
  assert.match(source, /fetch\(cohortRevisionRequestUrl\(scope, aid, nextRevision\), \{\s*cache: "no-store",\s*signal: controller\.signal,/);
  assert.match(source, /const primary = useComparisonProfile\(profileScope, profileScopeKey, primaryAid, activeModeLabel, t, cohortController\.reload\)/);
  assert.match(source, /const secondary = useComparisonProfile\(profileScope, profileScopeKey, secondaryAid, activeModeLabel, t, secondaryCohortController\.reload\)/);
  assert.match(source, /if \(active\(\)\) await onRefreshedRef\.current\?\.\(next\)/);
});

test("profile and cohort generations isolate mode and player switches", async () => {
  const source = await readFile("components/ComparePage.tsx", "utf8");
  const profileHook = source.slice(
    source.indexOf("function useComparisonProfile"),
    source.indexOf("function useComparisonCohort"),
  );
  const cohortHook = source.slice(
    source.indexOf("function useComparisonCohort"),
    source.indexOf("export default function ComparePage"),
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

test("compare uses scope-specific links back to each full profile", async () => {
  const source = await readFile("components/ComparePage.tsx", "utf8");
  assert.match(source, /appRouteMode\(scope\.mode\)/);
  assert.match(source, /encodeURIComponent\(scope\.cycleId\)/);
  assert.match(source, /href=\{profileHref\(scope, aid\)\}/);
  assert.match(source, /<ProfilePortrait[\s\S]*mode=\{scope\.mode\}[\s\S]*cycleId=\{scope\.cycleId\}/);
});

test("compare integrates progression for the three raid-based modes", async () => {
  const source = await readFile("components/ComparePage.tsx", "utf8");
  assert.match(source, /bothPlayersSelected && scope\.mode !== "arena" \? <CompareProgressionSection/);
  assert.match(source, /mode=\{scope\.mode\}/);
  assert.match(source, /primary=\{primaryProgression\}/);
  assert.match(source, /secondary=\{secondaryProgression\}/);
  assert.match(source, /updatedAt: primaryCurrent\?\.data\?\.updatedAt \?\? null/);
});

test("comparison navigation, graph state, and honest capability copy are bilingual", async () => {
  const dictionary = await readFile("lib/i18n/dictionary.ts", "utf8");

  assert.match(dictionary, /"compare\.benchmarkOnly": "The cohort benchmark is available for this mode; percentiles are not\."/);
  assert.match(dictionary, /"compare\.benchmarkOnly": "Для этого режима доступен эталон когорты, но процентили недоступны\."/);
  assert.match(dictionary, /"compare\.progressionArenaUnavailable": "Arena progression comparison is unavailable because Arena has no progression history\."/);
  assert.match(dictionary, /"compare\.progressionArenaUnavailable": "Сравнение прогрессии в Арене недоступно: у Арены нет истории прогрессии\."/);
  assert.match(dictionary, /"compare\.metricsTitle": "Metric comparison"/);
  assert.match(dictionary, /"compare\.metricsTitle": "Сравнение метрик"/);
  assert.match(dictionary, /"player\.refreshDirectHint": "Check the public profile API for a newer snapshot now\."/);
  assert.match(dictionary, /"player\.refreshDirectHint": "Сразу запросить публичный API профиля и проверить, есть ли новый снимок\."/);
});
