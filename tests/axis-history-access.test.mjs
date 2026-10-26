import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const compiled = ts.transpileModule(readFileSync("components/AxisMatchHistory.tsx", "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const data = { available: true, stale: false, page: 1, pages: 1, total: 1, season: "current", updatedAt: 123,
  matches: [{ number: 42, time: null, queue: null, maps: [], winner: null, teams: [], rounds: null }] };

function historyHarness() {
  const values = new Map([[7, data]]);
  let stateIndex = 0;
  let effects = [];
  const componentModule = { exports: {} };
  new Function("require", "module", "exports", compiled)(name => {
    if (name === "react") return {
      useState(initial) {
        const index = stateIndex++;
        if (!values.has(index)) values.set(index, initial);
        return [values.get(index), next => values.set(index, typeof next === "function" ? next(values.get(index)) : next)];
      },
      useRef: value => ({ current: value }), useId: () => "history-test",
      useEffect: (effect, deps) => effects.push({ effect, deps }),
    };
    if (name === "@/lib/i18n/context") return { useI18n: () => ({ lang: "en", t: key => key }) };
    if (name === "@/lib/axis-league") return { AXIS_REFRESH_MS: 300_000 };
    if (name === "@/components/AxisMatchSubmission") return { default: props => React.createElement("div", { "data-upload-match": props.matchNumber }) };
    if (name.startsWith("@/components/")) return { default: () => null };
    return require(name);
  }, componentModule, componentModule.exports);
  return { render(props = {}) {
    stateIndex = 0; effects = [];
    const html = renderToStaticMarkup(componentModule.exports.default(props));
    return { html, effects };
  } };
}

test("history mounts screenshot submission only for players, below the match results", () => {
  for (const canEditKda of [false, true]) {
    const { html } = historyHarness().render({ canEditKda });
    assert.match(html, /<details[^>]*open=""/);
    assert.doesNotMatch(html, /data-upload-match|axis-match-photo|axis-photo-paste/);
    const permitted = historyHarness().render({ canEditKda, canSubmitScreenshot: true }).html;
    assert.equal(permitted.includes('data-upload-match="42"'), !canEditKda, "moderators use the existing statistics editor");
  }
});

test("public history never asks for moderation; refreshes with unchanged archive time still refresh moderator review", async t => {
  const saved = { fetch: globalThis.fetch, window: globalThis.window, document: globalThis.document, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  t.after(() => Object.assign(globalThis, saved));
  const requests = [];
  const events = new Map();
  globalThis.window = { addEventListener(name, listener) { events.set(name, listener); }, removeEventListener(name) { events.delete(name); } };
  globalThis.document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
  globalThis.setTimeout = () => 0; globalThis.clearTimeout = () => {};
  globalThis.fetch = async url => {
    requests.push(String(url));
    return { ok: true, json: async () => String(url).includes("match-review") ? { reviews: [] } : structuredClone(data) };
  };
  const publicView = historyHarness().render();
  publicView.effects[0].effect();
  assert.deepEqual(requests, []);
  const harness = historyHarness();
  const first = harness.render({ canEditKda: true });
  const cleanupReview = first.effects[0].effect();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.filter(url => url.includes("match-review")).length, 1);
  const cleanupHistory = first.effects[3].effect();
  await new Promise(resolve => setImmediate(resolve));
  const refreshed = harness.render({ canEditKda: true });
  assert.notDeepEqual(refreshed.effects[0].deps, first.effects[0].deps, "fresh history invalidates moderation even when updatedAt stays unchanged");
  cleanupReview();
  const cleanupRefreshed = refreshed.effects[0].effect();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.filter(url => url.includes("match-review")).length, 2);
  assert.equal(requests.filter(url => url.includes("/api/axis-league/history")).length, 1);
  const linked = harness.render({ canEditKda: true, players: [{ id: "1", profile: { aid: 1001, mode: "arena" } }] });
  assert.notDeepEqual(linked.effects[0].deps, refreshed.effects[0].deps, "a changed profile link invalidates old OCR warnings immediately");
  events.get("focus")(); events.get("focus")();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.filter(url => url.includes("match-review")).length, 3, "returning from a profile refresh rechecks warnings without overlapping requests");
  globalThis.document.visibilityState = "hidden";
  events.get("focus")();
  assert.equal(requests.filter(url => url.includes("match-review")).length, 3);
  cleanupHistory(); cleanupRefreshed();
});

test("unreadable nicknames keep a complete match flagged for moderator review", async () => {
  const { dict } = await import("../lib/i18n/dictionary.ts");
  for (const lang of ["en", "ru"]) {
    const code = ts.transpileModule(readFileSync("components/AxisMatchReview.tsx", "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    const componentModule = { exports: {} };
    new Function("require", "module", "exports", code)(name => {
      if (name === "@/lib/i18n/context") return { useI18n: () => ({ t: (key, vars = {}) => Object.entries(vars).reduce((text, [key, value]) => text.replace(`{${key}}`, value), dict[lang][key]) }) };
      if (name === "@/lib/axis-match-photo") return { axisPhotoUrl: () => "" };
      if (name === "@/components/AxisMatchPhoto") return { AxisPhotoViewer: () => null };
      return require(name);
    }, componentModule, componentModule.exports);
    const review = { matchNumber: 42, missingStats: [], nicknameMismatches: [], unreadableNames: 2, conflicts: [], roundConflict: null, submissions: [] };
    assert.equal(componentModule.exports.axisReviewNeedsAttention(review), true);
    const html = renderToStaticMarkup(React.createElement(componentModule.exports.default, { review }));
    assert.ok(html.includes(dict[lang]["axis.review.unreadableNames"].replace("{n}", "2")));
    assert.ok(!html.includes(dict[lang]["axis.review.complete"]));
    assert.equal(componentModule.exports.axisReviewNeedsAttention({ ...review, unreadableNames: 0 }), false);
    const complete = { ...review, unreadableNames: 0, submissions: [{ photoRevision: "a".repeat(64) }] };
    const render = value => renderToStaticMarkup(React.createElement(componentModule.exports.default, { review: value }));
    assert.equal(render(complete), "", "complete matches must not leave a status panel or screenshot");
    assert.equal(render({ ...complete, missingStats: ["Player"], conflicts: [{ name: "Player" }], roundConflict: {} }), "", "only nickname warnings belong above the editor");
    const warning = render({ ...complete, nicknameMismatches: ["Wrong Nick"] });
    assert.ok(warning.includes(dict[lang]["axis.review.unmatched"].replace("{names}", "Wrong Nick")));
    assert.match(warning, /role="status"/);
    assert.doesNotMatch(warning, /<img|<input|<button|<details|<section|<ul/);
  }
});

test("players open only the screenshot picker with Edit and can close it without numeric fields", () => {
  const code = ts.transpileModule(readFileSync("components/AxisMatchSubmission.tsx", "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const values = [], componentModule = { exports: {} }; let stateIndex = 0;
  new Function("require", "module", "exports", code)(name => {
    if (name === "react") return {
      useState(initial) { const index = stateIndex++; if (!(index in values)) values[index] = initial;
        return [values[index], value => { values[index] = typeof value === "function" ? value(values[index]) : value; }]; },
      useRef: current => ({ current }), useCallback: callback => callback, useEffect() {},
    };
    if (name === "@/lib/i18n/context") return { useI18n: () => ({ t: key => key }) };
    if (name === "@/components/AxisMatchPhoto") return { default: props => {
      assert.equal(props.uploadOnly, true);
      return React.createElement("input", { type: "file", "aria-label": "axis.photo.select" });
    } };
    return require(name);
  }, componentModule, componentModule.exports);
  const render = () => { stateIndex = 0; return componentModule.exports.default({ matchNumber: 42, onSaved() {} }); };
  const findButton = tree => {
    if (!React.isValidElement(tree)) return null;
    if (tree.type === "button") return tree;
    for (const child of React.Children.toArray(tree.props.children)) { const found = findButton(child); if (found) return found; }
    return null;
  };
  let tree = render(), button = findButton(tree);
  assert.equal(button.props.children, "axis.kda.edit");
  assert.equal(button.props["aria-expanded"], false);
  assert.doesNotMatch(renderToStaticMarkup(tree), /type="file"|type="number"/);
  button.props.onClick(); tree = render(); button = findButton(tree);
  assert.equal(button.props.children, "axis.kda.cancel");
  assert.equal(button.props["aria-expanded"], true);
  assert.equal((renderToStaticMarkup(tree).match(/type="file"/g) ?? []).length, 1);
  assert.doesNotMatch(renderToStaticMarkup(tree), /type="number"|<form|axis-kda-inline|axis-round-inputs/);
  button.props.onClick();
  assert.doesNotMatch(renderToStaticMarkup(render()), /type="file"|type="number"/);
});
