import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import ts from "typescript";
import * as showcase from "../lib/home-showcase.ts";
import * as cohort from "../lib/profile-cohort.ts";

const require = createRequire(import.meta.url);
const turn = () => new Promise(setImmediate);
const favorites = [{ aid: 42, nickname: "Favorite", isMain: true }];
const profile = (aid = 42, mode = "regular", cycleId = "persistent") => ({
  identity: { aid, mode, cycleId }, viewModel: { identity: { nickname: `Player ${aid}` } },
  comparisonStats: { kdRatio: 4, pmcKdRatio: 2, killsPerRaid: 3, pmcSurvivalRate: 50, longestWinStreak: 4, level: 30 },
});
const nodes = (element) => !element || typeof element !== "object" ? [] :
  [element, ...[element.props?.children].flat(Infinity).flatMap(nodes)];

// Execute the actual component and request effects with deterministic hooks.
// JSX remains inspectable; DOM-only layout effects are deliberately excluded.
async function harness(file, props, request, width = 1120) {
  const state = [], effects = [], queued = [];
  let cursor = 0, tree;
  const slot = (initial) => {
    const index = cursor++;
    if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
    return [state[index], (value) => { state[index] = typeof value === "function" ? value(state[index]) : value; }];
  };
  const react = {
    useState: slot, useRef: (value) => slot(() => ({ current: value }))[0],
    useMemo: (fn, deps) => {
      const memo = slot(() => ({ deps, value: fn() }))[0];
      if (deps.some((value, i) => !Object.is(value, memo.deps[i]))) { memo.deps = deps; memo.value = fn(); }
      return memo.value;
    }, useId: () => `test-${cursor++}`,
    startTransition: (fn) => fn(), useLayoutEffect: () => {},
    useEffect: (fn, deps) => {
      const index = cursor++;
      const previous = effects[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        queued.push(() => { previous?.cleanup?.(); effects[index] = { deps, cleanup: fn() }; });
      }
    },
  };
  const bindings = {
    react,
    "@/lib/home-showcase": showcase,
    "@/lib/profile-cohort": cohort,
    "@/lib/i18n/context": { useI18n: () => ({ t: (key) => key, lang: "ru" }) },
    "@/lib/favorites/context": { useFavorites: () => ({ favorites, authStatus: "authenticated", loading: false, enabled: true }) },
    "@/lib/favorites/identity": { favoriteKey: (value) => value.aid },
    "@/lib/client-profile-request": { loadPlayerProfileResponse: request },
    "@/lib/client-average-request": { loadAverageJson: request },
    "@/lib/progression-timeline-response": { validTimelineResponse: () => true, timelineHasPoints: Boolean, timelineHasPlayerHistory: Boolean },
    "./useChartWidth": { useChartWidth: () => ({ width, ref: { current: null } }) },
  };
  const source = await readFile(file, "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const compiled = { exports: {} };
  new Function("require", "module", "exports", output)((name) => bindings[name] ?? (name.startsWith("@/components/") ? { default: () => null } : require(name)), compiled, compiled.exports);
  const render = (next = props) => { props = next; cursor = 0; tree = compiled.exports.default(props); while (queued.length) queued.shift()(); return tree; };
  const click = (predicate) => { const node = nodes(tree).find(predicate); assert.ok(node, "expected control is present"); node.props.onClick(); render(); };
  render();
  return { render, click, get tree() { return tree; }, dispose() { for (const effect of effects) effect?.cleanup?.(); } };
}

for (const width of [360, 1120]) {
  test(`favorite radar renders without a cohort at width ${width}`, async () => {
    const calls = [];
    const props = { profile: profile(7), cohort: undefined, gameMode: "regular", cycleId: "persistent" };
    const h = await harness("components/home/HomeComparison.tsx", props, async (url, options) => {
      calls.push({ url, options }); return { ok: true, body: profile() };
    }, width);
    h.click((n) => n.type === "button" && n.props.children === "home.favoritePlayer");
    await turn(); h.render();
    assert.equal(calls[0].options.force, false);
    assert.ok(nodes(h.tree).some((n) => n.type === "svg"));
    const hits = nodes(h.tree).filter((n) => n.props?.["data-series"]);
    assert.equal(hits.length, 12, "both players have plotted points without population data");
    assert.ok(hits.every((n) => Number.isFinite(n.props.cx) && Number.isFinite(n.props.cy)));
    h.render({ ...props, cohort: null });
    assert.ok(nodes(h.tree).some((n) => n.type === "svg"));
    assert.equal(calls.length, 1);
    h.dispose();
  });
}

test("favorite identity mismatch offers forced retries; ordinary switches reuse cache", async () => {
  const calls = [];
  const h = await harness("components/home/HomeComparison.tsx", { profile: profile(7), cohort: null, gameMode: "regular", cycleId: "persistent" }, async (url, options) => {
    calls.push({ url, options }); return { ok: true, body: profile(42, "pve") };
  });
  const retry = (n) => n.type === "button" && n.props.children === "leaderboard.retry";
  h.click((n) => n.type === "button" && n.props.children === "home.favoritePlayer");
  await turn(); h.render();
  assert.ok(!nodes(h.tree).some((n) => n.type === "svg"));
  for (let i = 0; i < 2; i++) { h.click(retry); await turn(); h.render(); }
  assert.deepEqual(calls.map((c) => c.options.force), [false, true, true]);
  h.click((n) => n.type === "button" && n.props.children === "home.averagePlayer");
  h.click((n) => n.type === "button" && n.props.children === "home.favoritePlayer");
  await turn(); h.render();
  assert.equal(calls.at(-1).options.force, false);
  h.dispose();
});

test("favorite mode/cycle changes abort the old consumer and ignore its late response", async () => {
  const calls = [];
  const props = { profile: profile(7), cohort: null, gameMode: "regular", cycleId: "persistent" };
  const h = await harness("components/home/HomeComparison.tsx", props, (url, options) => new Promise((resolve) => calls.push({ url, options, resolve })));
  h.click((n) => n.type === "button" && n.props.children === "home.favoritePlayer");
  h.render({ ...props, profile: profile(7, "seasonal", "s2"), gameMode: "seasonal", cycleId: "s2" });
  assert.equal(calls[0].options.signal.aborted, true);
  calls[0].resolve({ ok: true, body: profile() }); await turn(); h.render();
  assert.ok(!nodes(h.tree).some((n) => n.type === "svg"));
  calls[1].resolve({ ok: true, body: profile(42, "seasonal", "s1") }); await turn(); h.render();
  assert.ok(nodes(h.tree).some((n) => n.props?.children === "leaderboard.retry"));
  h.dispose();
});

test("timeline failure ends loading, retry recovers, and failed refresh keeps the chart", async () => {
  const originalWindow = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  const calls = [];
  const props = { aid: 7, mode: "regular", cycleId: "persistent", hours: 10, pmcRaids: 20 };
  const timeline = { identity: { aid: 7, mode: "regular", cycleId: "persistent" }, comparison: {}, metrics: {}, history: { ready: false } };
  let h;
  try {
    h = await harness("components/ProgressionPanel.tsx", props, (url, options) => new Promise((resolve, reject) => calls.push({ url, options, resolve, reject })));
    assert.equal(calls[0].options.maxUnavailableRetries, 2);
    calls[0].reject(new Error("busy")); await turn(); h.render();
    assert.ok(!nodes(h.tree).some((n) => n.props?.className?.includes("skeleton")));
    h.click((n) => n.type === "button" && n.props.children === "leaderboard.retry");
    assert.equal(calls[1].options.forceRefresh, true);
    calls[1].resolve(timeline); await turn(); h.render();
    const chart = () => nodes(h.tree).find((n) => n.props?.data === timeline);
    assert.ok(chart());
    h.render({ ...props, refreshRevision: 1 });
    calls[2].reject(new Error("busy")); await turn(); h.render();
    assert.ok(chart(), "failed refresh must preserve the last successful chart");
    assert.ok(nodes(h.tree).some((n) => n.props?.children === "leaderboard.retry"));
  } finally { h?.dispose(); globalThis.window = originalWindow; }
});


test("secondary timeline failure offers retry without resetting the primary chart", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  const calls = [];
  const props = { aid: 7, mode: "regular", cycleId: "persistent", hours: 10, pmcRaids: 20 };
  const primary = { identity: { aid: 7, mode: "regular", cycleId: "persistent" }, comparison: {}, metrics: {}, history: { ready: false } };
  const secondary = { ...primary, identity: { ...primary.identity, aid: 42 }, metrics: { xp: { player: [{ value: 1 }] } } };
  let h;
  try {
    h = await harness("components/ProgressionPanel.tsx", props, (url, options) => new Promise((resolve, reject) => calls.push({ url, options, resolve, reject })));
    calls[0].resolve(primary); await turn(); h.render();
    const select = nodes(h.tree).find((n) => n.type === "select");
    select.props.onChange({ target: { value: "42" } }); h.render();
    assert.equal(calls[1].options.maxUnavailableRetries, 2);
    calls[1].reject(new Error("busy")); await turn(); h.render();
    h.click((n) => n.type === "button" && n.props.children === "leaderboard.retry");
    assert.equal(calls[2].options.forceRefresh, true);
    assert.ok(nodes(h.tree).some((n) => n.props?.data === primary));
    calls[2].resolve(secondary); await turn(); h.render();
    const chart = nodes(h.tree).find((n) => n.props?.data === primary);
    assert.equal(chart.props.comparison.aid, 42);
    assert.equal(calls.length, 3, "secondary retry must not refetch the primary timeline");
  } finally { h?.dispose(); globalThis.window = previousWindow; }
});
