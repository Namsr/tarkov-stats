import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: pathToFileURL(resolve(specifier.slice(2) + ".ts")).href };
    }
    return next(specifier, context);
  },
});
const { buildNumericHistogram } = await import("../lib/histogram.ts");
const { cumulativeLevelBands } = await import("../lib/seasonal/ui.ts");
const binary = process.env.RUST_PERSISTENT_UI_CONTRACT_BIN || resolve(
  "rust/ui/target/release/examples",
  `persistent-contract${process.platform === "win32" ? ".exe" : ""}`,
);
function native(operations) {
  assert.ok(existsSync(binary), "build the Rust persistent-contract example first");
  const result = spawnSync(binary, [], {
    input: JSON.stringify(operations), encoding: "utf8", timeout: 15000,
    windowsHide: true, maxBuffer: 4 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function close(actual, expected, path = "result") {
  if (typeof expected === "number") {
    assert.equal(typeof actual, "number", path);
    assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${path}: ${actual} != ${expected}`);
    return;
  }
  if (expected && typeof expected === "object") {
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), path);
    for (const [key, value] of Object.entries(expected)) close(actual[key], value, `${path}.${key}`);
    return;
  }
  assert.equal(actual, expected, path);
}

test("persistent Rust UI pools the actual TS buckets without averaging medians again", () => {
  const cases = [
    [],
    [{ lo: 0, hi: 50, n: 2, sum: 100 }, { lo: 50, hi: 100, n: 3, sum: 3 }],
    Array.from({ length: 100 }, (_, i) => ({ lo: i * 50, hi: i === 99 ? null : (i + 1) * 50, n: 1 + i % 11, sum: (i % 17) * 7.25 })),
  ];
  const operations = cases.flatMap(buckets => [0, 1, 2, 8, 36].map(cap => ({ op: "histogram", body: { buckets }, cap })));
  const actual = native(operations);
  operations.forEach((op, i) => close(actual[i], buildNumericHistogram(op.body.buckets, op.cap), `histogram ${i}`));
});

function reactRangeReference() {
  const source = readFileSync("app/average/page.tsx", "utf8");
  const tree = ts.createSourceFile("average.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = ["boundaryPosition", "valueAtPosition", "selectBin"];
  const found = [];
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) found.push(node.getText(tree));
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.equal(found.length, 3);
  const gap = source.match(/const BAR_GAP_PX\s*=\s*(\d+);/);
  assert.ok(gap);
  const code = ts.transpileModule(`const BAR_GAP_PX=${gap[1]};\n${found.join("\n")}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function("bins", "bounds", "chartWidth", "value", "position", "high", "index", `
    const minRangeSpan=Math.min(50,bounds.max-bounds.min);
    let selection;
    const setSelection=(value)=>selection=value;
    ${code}
    selectBin(bins[index]);
    return {
      position: boundaryPosition(high ? value+1 : value, high ? 'high' : 'low'),
      valueAt: valueAtPosition(position, high ? 'high' : 'low'),
      selection,
    };
  `);
}

test("persistent inclusive slider geometry and minimum span match the actual React functions", () => {
  const reference = reactRangeReference();
  const bins = [
    { lo: 0, hi: 50, n: 10, sum: 20, label: "0–50" },
    { lo: 50, hi: 200, n: 10, sum: 50, label: "50–200" },
    { lo: 200, hi: null, n: 10, sum: 100, label: "200+" },
  ];
  const bounds = { min: 0, max: 399 };
  const operations = [];
  for (const width of [0, 100, 360, 768, 1280]) {
    for (const high of [false, true]) {
      for (const value of [0, 1, 49, 50, 199, 200, 399]) {
        operations.push({ op: "range", bins, bounds, width, high, value, position: value / 399, index: value % 3 });
      }
    }
  }
  const actual = native(operations);
  operations.forEach((op, i) => close(actual[i], reference(op.bins, op.bounds, op.width, op.value, op.position, op.high, op.index), `range ${i}`));
});

test("shared XP snapshot produces identical cumulative level bands in Rust and TS", () => {
  const levels = JSON.parse(readFileSync("lib/player-levels-v2026-07-22.json", "utf8"));
  assert.equal(levels.length, 79);
  assert.deepEqual(native([{ op: "bands" }])[0], cumulativeLevelBands(levels));
});

test("persistent state keeps current URL statistic/period rules and isolates selected/context identities", () => {
  const queries = [
    "", "statistic=median&period=90d", "statistic=bad&period=bad",
    "statistic=median&statistic=bad&period=90d&period=all",
    "unknown=keep&unknown=again&min=0x10&max=30", "?statistic=median&period=90d",
  ];
  const operations = queries.flatMap(query => ["regular", "pve"].map(mode => ({ op: "state", query, mode })));
  const actual = native(operations);
  operations.forEach((op, i) => {
    // Rust takes the raw URI query; browser URLSearchParams receives one separator.
    const params = new URLSearchParams("?" + op.query);
    const state = actual[i];
    assert.equal(state.statistic, params.get("statistic") === "median" ? "median" : "trimmed_mean");
    assert.equal(state.period, params.get("period") === "90d" ? "90d" : "all");
    assert.equal(state.mode, op.mode);
    assert.equal(new URL(state.requests[0], "http://local").searchParams.get("mode"), op.mode);
    assert.equal(new URL(state.requests[1], "http://local").searchParams.has("min"), false);
    assert.ok(state.href.startsWith(`/population/${op.mode}`));
  });
});

test("persistent Rust panel translation literals resolve in both shared languages", () => {
  const messages = JSON.parse(readFileSync("lib/i18n/messages.json", "utf8"));
  const used = new Set();
  for (const name of ["view.rs", "panels.rs"]) {
    const source = readFileSync(`rust/ui/src/persistent/${name}`, "utf8");
    for (const [, key] of source.matchAll(/"((?:average|arena|common|metric|achievement|achv|progression|seasonal|player|profile|unit|fav|mode|nav|radar|range)\.[a-zA-Z][a-zA-Z0-9_.]*)"/g)) { if (!key.endsWith(".")) used.add(key); }
  }
  assert.ok(used.size > 80, "inspect both complete panel modules");
  for (const key of used) {
    for (const lang of ["en", "ru"]) assert.equal(typeof messages[lang][key], "string", `${lang}: ${key}`);
  }
});
