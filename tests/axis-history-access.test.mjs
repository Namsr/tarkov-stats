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
  const saved = { fetch: globalThis.fetch, document: globalThis.document, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  t.after(() => Object.assign(globalThis, saved));
  const requests = [];
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
  cleanupHistory(); cleanupRefreshed();
});
