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

test("the first expanded match exposes uploads without an initial toggle event", () => {
  const { html } = historyHarness().render({ canSubmitScreenshot: true });
  assert.match(html, /<details[^>]*open=""/);
  assert.match(html, /data-upload-match="42"/);
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
    assert.equal(componentModule.exports.axisReviewNeedsAttention(review, false), true);
    const html = renderToStaticMarkup(React.createElement(componentModule.exports.default, { review, roundsMissing: false }));
    assert.ok(html.includes(dict[lang]["axis.review.unreadableNames"].replace("{n}", "2")));
    assert.ok(!html.includes(dict[lang]["axis.review.complete"]));
    assert.equal(componentModule.exports.axisReviewNeedsAttention({ ...review, unreadableNames: 0 }, false), false);
  }
});
