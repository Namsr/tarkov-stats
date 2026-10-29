import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
const { transform } = createRequire(import.meta.url)("lightningcss");
const source = await readFile(new URL("../scripts/check-rust-persistent-browser.mjs", import.meta.url), "utf8");
const tree = ts.createSourceFile("persistent-browser.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function literal(tree, name) {
  const statement = tree.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(tree) === name));
  assert.ok(statement, `actual ${name} declaration exists`);
  return runInNewContext(statement.getText(tree) + `\n${name}`);
}
test("persistent radio selectors parse for every functional control, including numeric-leading periods", () => {
  const declarations = [];
  function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "radio") declarations.push(node); ts.forEachChild(node, visit); }
  visit(tree); assert.equal(declarations.length, 1, "functional calls must not shadow the tested helper");
  const radio = literal(tree, "radio");
  const parse = selector => transform({ filename: "selector.css", code: Buffer.from(selector + " { color: red }"), minify: true }).code.toString();
  assert.throws(() => parse("main input[type=radio][value=90d]"));
  for (const value of ["median", "trimmed_mean", "all", "90d", "pmc_raids"]) {
    const selector = radio(value);
    assert.match(parse(selector), /\{color:red\}/);
    if (value === "90d") assert.match(selector, /\[value="90d"\]/);
  }
});
test("actual mouse helper scrolls instantly and rejects an obscured target", async () => {
  const found = {};
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && ["point", "click"].includes(node.name?.text)) found[node.name.text] = node.getText(tree);
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(tree) === "visible")) found.visible = node.getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree); for (const name of ["point", "click", "visible"]) assert.ok(found[name]);
  let top = 1400, blocked = false, scrollOptions; const child = { tagName: "SPAN", closest: () => ({ getAttribute: () => "/population/regular" }) };
  const target = { textContent: "Regular", getClientRects: () => [{}], matches: () => false,
    scrollIntoView(options) { scrollOptions = options; if (options.behavior === "instant") top = 100; },
    getBoundingClientRect: () => ({ left: 10, top, width: 40, height: 20 }), contains: hit => hit === target || hit === child };
  const overlay = { tagName: "D".repeat(100), closest: () => ({ getAttribute: () => "/" + "x".repeat(300) }) };
  const document = { querySelectorAll: () => [target], elementFromPoint: (_x, y) => y >= 0 && y < 600 ? (blocked ? overlay : child) : null };
  const getComputedStyle = () => ({ visibility: "visible", display: "block" });
  const events = [], evidence = {}, tab = { async send(method, value) { events.push({ method, value }); } };
  const evaluate = expression => runInNewContext(expression, { document, getComputedStyle });
  const { point, click } = runInNewContext(found.visible + "\n" + found.point + "\n" + found.click + "\n({point,click})", { evaluate, tab, evidence });
  target.scrollIntoView({ block: "center" });
  assert.equal(target.getBoundingClientRect().top, 1400, "default smooth scrolling leaves the old offscreen rectangle in this model");
  const location = await point("main a", "Regular");
  assert.equal(scrollOptions.behavior, "instant"); assert.equal(location.x, 30); assert.equal(location.y, 110); assert.equal(location.hitTag, "SPAN"); assert.equal(location.hitHref, "/population/regular");
  await click("main a", "Regular");
  assert.deepEqual(events.map(event => event.value.type), ["mousePressed", "mouseReleased"]);
  assert.ok(events.every(event => event.method === "Input.dispatchMouseEvent" && event.value.x === 30 && event.value.y === 110));
  assert.equal(evidence.lastMouseTarget.dispatched, true); assert.equal(evidence.lastMouseTarget.hitHref, "/population/regular");
  blocked = true;
  await assert.rejects(click("a".repeat(250), "Regular"), error => {
    const details = JSON.parse(error.message.split("Control is not hittable ")[1]);
    assert.equal(details.selector.length, 200); assert.equal(details.x, 30); assert.equal(details.y, 110);
    assert.equal(details.hitTag.length, 40); assert.equal(details.hitHref.length, 200); return true;
  });
  assert.equal(events.length, 2);
});
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
  const files = ["scripts/check-rust-persistent-browser.mjs", "scripts/serve-rust-persistent-benchmark.mjs",
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
