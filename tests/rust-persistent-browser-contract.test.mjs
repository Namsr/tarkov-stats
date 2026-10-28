import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { assertSeasonalRequests } from "../scripts/lib/check-rust-seasonal-functional.mjs";
const source = await readFile(new URL("../scripts/check-rust-persistent-browser.mjs", import.meta.url), "utf8");
const tree = ts.createSourceFile("persistent-browser.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function literal(tree, name) {
  const statement = tree.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(tree) === name));
  assert.ok(statement, `actual ${name} declaration exists`);
  return runInNewContext(statement.getText(tree) + `\n${name}`);
}
test("persistent observer requires actual300 profiles, all13 numeric values and both hydrated range controls", () => {
  const script = literal(tree, "instrumentation");
  let now = 1, changed;
  const nodes = new Map(), collections = new Map(), window = {};
  const document = { documentElement: null, visibilityState: "visible", querySelector: s => nodes.get(s), querySelectorAll: s => collections.get(s) || [] };
  class PerformanceObserver { static supportedEntryTypes = ["paint", "largest-contentful-paint", "layout-shift"]; observe() {} takeRecords() { return []; } }
  class MutationObserver { constructor(callback) { changed = callback; } observe(target) { assert.equal(target, document); } }
  runInNewContext(script, { document, window, PerformanceObserver, MutationObserver, performance: { now: () => now, timeOrigin: 1, getEntriesByType: () => [] } });
  const snapshot = () => window.__rustArenaBenchmark.snapshot();
  assert.equal(snapshot().usefulDomMs, null); assert.equal(snapshot().marker, "missing");
  document.documentElement = { lang: "ru", outerHTML: '<html><script src="/_rust/persistent/hash/tarkov_ui.js"></script></html>' };
  nodes.set(".average-sampleline", { textContent: "На основе 300 профилей" });
  const metricSelector = ".arena-combat-ring__value strong,.detail-grid--compact .metric-card__value";
  collections.set(metricSelector, Array.from({ length: 12 }, () => ({ textContent: "1,25" })));
  collections.set("input[type=range]", [{ disabled: true, value: "0" }, { disabled: false, value: "10000" }]);
  changed(); assert.equal(snapshot().usefulDomMs, null);
  collections.get(metricSelector).push({ textContent: "—" });
  changed(); assert.equal(snapshot().usefulDomMs, null);
  collections.get(metricSelector)[12].textContent = "1 200";
  now = 20; changed(); assert.equal(snapshot().usefulDomMs, 20); assert.equal(snapshot().controlsReadyMs, null);
  collections.get("input[type=range]")[0].disabled = false;
  now = 30; changed(); assert.equal(snapshot().controlsReadyMs, 30); assert.equal(snapshot().marker, "rust");
  now = 40; changed(); assert.equal(snapshot().usefulDomMs, 20); assert.equal(snapshot().controlsReadyMs, 30);
});
test("persistent paired browser recipe retains the declared Arena Linux emulation and4cold/6warm pairs", async () => {
  const arenaSource = await readFile(new URL("../scripts/benchmark-rust-arena-browser.mjs", import.meta.url), "utf8");
  const arenaTree = ts.createSourceFile("arena.mjs", arenaSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const actual = literal(tree, "conditions"), arena = literal(arenaTree, "conditions");
  for (const field of ["viewport", "locale", "cookie", "cpuSlowdown", "network", "warmPairs", "coldPairs", "coldMeaning", "warmMeaning", "settling"]) assert.deepEqual(JSON.parse(JSON.stringify(actual[field])), JSON.parse(JSON.stringify(arena[field])), field);
  assert.equal(actual.warmPairs, 6); assert.equal(actual.coldPairs, 4);
  assert.match(actual.ancillary, /PvE only/); assert.match(actual.ancillary, /Regular.*correctness/);
});
test("owned browser/HTTP sources are strictly UTF8, not silently replacement-decoded fixtures", async () => {
  const files = ["scripts/check-rust-persistent-browser.mjs", "scripts/lib/check-rust-seasonal-functional.mjs", "scripts/serve-rust-persistent-benchmark.mjs",
    "scripts/lib/benchmark-rust-ui-browser.mjs", "scripts/lib/browser-cdp.mjs", "scripts/lib/serve-rust-ui-fixture.mjs",
    "tests/fixtures/rust-persistent-ui.mjs", "tests/rust-persistent-ui-http.test.mjs",
    "tests/rust-achievements-http.test.mjs", "rust/ui/src/persistent/panels.rs", "rust/ui/src/persistent/crosshair.rs"];
  for (const file of files) {
    const bytes = await readFile(new URL("../" + file, import.meta.url));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    assert.equal(text.includes("\ufffd"), false, file);
  }
});

test("focus delay proof requires a NEW real pending filtered PvE average, not an idle node",()=>{
 const declaration=tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==="pendingFilteredRequest");assert.ok(declaration);
 const pending=runInNewContext(declaration.getText(tree)+"\npendingFilteredRequest",{URL});
 const before=new Set(["old"]);
 const request=(id,url,extra={})=>({id,url,finished:false,...extra});
 const rejected=[request("old","http://local/api/average?mode=pve&min=100"),request("unfiltered","http://local/api/average?mode=pve"),request("warm-zero","http://local/api/average?mode=pve&min=0"),request("other-mode","http://local/api/average?mode=regular&min=100"),request("metrics","http://local/api/average/metrics?mode=pve&min=100"),request("finished","http://local/api/average?mode=pve&min=100",{finished:true}),request("aborted","http://local/api/average?mode=pve&min=100",{canceled:true})];
 const requests=new Map(rejected.map(r=>[r.id,r]));assert.equal(pending(requests,before),undefined);
 const real=request("new-demand","http://local/api/average?mode=pve&min=1450&max=11999");requests.set(real.id,real);assert.equal(pending(requests,before),real);
});


test("Seasonal browser request evidence requires a real 90d main response and all-period same-cycle overlays", () => {
  const requests = [
    { url: "http://local/api/seasonal/average?cycle=native-s1&period=90d", status: 200 },
    { url: "http://local/api/average/metrics?mode=seasonal&cycle=native-s1&period=all", status: 200 },
    { url: "http://local/api/average/metrics?mode=pve&period=90d", status: 200 },
  ];
  assert.doesNotThrow(() => assertSeasonalRequests(requests, "native-s1", "fixture"));
  assert.throws(() => assertSeasonalRequests(requests.slice(1), "native-s1", "fixture"), /90d average/);
  assert.throws(() => assertSeasonalRequests(requests.slice(0, 1), "native-s1", "fixture"), /overlay must request all/);
  assert.throws(() => assertSeasonalRequests([...requests, { url: "http://local/api/average/metrics?mode=seasonal&cycle=native-s1&period=90d", status: 200 }], "native-s1", "fixture"), /must not leak/);
  assert.throws(() => assertSeasonalRequests([...requests, { url: "http://local/api/average/metrics?mode=seasonal&cycle=other&period=all", status: 200 }], "native-s1", "fixture"), /must not leak/);
});


test("Seasonal image suite preserves isolated selector, shared data and provenance without widening the timing recipe", async () => {
  const fixture = await readFile(new URL("../scripts/serve-rust-persistent-benchmark.mjs", import.meta.url), "utf8");
  const runner = await readFile(new URL("../scripts/lib/serve-rust-ui-fixture.mjs", import.meta.url), "utf8");
  const shell = await readFile(new URL("../scripts/benchmark-rust-arena-browser-image.sh", import.meta.url), "utf8");
  const workflow = await readFile(new URL("../.github/workflows/vps-image.yml", import.meta.url), "utf8");
  const seasonalSource = await readFile(new URL("../scripts/lib/check-rust-seasonal-functional.mjs", import.meta.url), "utf8");
  assert.match(fixture, /selectors: seasonal \? \["SEASONAL_POPULATION_UI_UPSTREAM"\]/);
  assert.match(fixture, /includeSeasonal: seasonal/);
  assert.match(fixture, /\/population\/pvp-season/);
  assert.match(runner, /SEASONAL_POPULATION_UI_UPSTREAM: `127\.0\.0\.1:\$\{nextPort\}`/);
  assert.match(runner, /progression:\{path:commonEnvironment\.PROGRESSION_SQLITE_PATH,shared:true\}/);
  assert.match(runner, /PRIVATE_UPSTREAM_BLOCKED/);
  for (const marker of ["--suite seasonal", "rust-seasonal-browser", "image-provenance.json"]) assert.ok(workflow.includes(marker), marker);
  assert.match(shell, /suite == seasonal/); assert.match(shell, /GITHUB_ACTIONS/); assert.match(shell, /sourceRevision/); assert.match(shell, /org\.tarkovstats\.rust-seasonal-population/);
  for (const marker of ["seasonal.unavailable", "history.back", "history.forward", "prefers-reduced-motion", "scriptExecutionDisabled", "unlockHours", "nameRu"]) assert.ok(seasonalSource.includes(marker), marker);
  const actual = literal(tree, "conditions"); assert.equal(actual.coldPairs, 4); assert.equal(actual.warmPairs, 6);
});
