import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import * as range from "../lib/arena/average-range.ts";
import { ARENA_MODE_KEYS, ARENA_METRIC_KEYS } from "../types/arena.ts";

const binary = resolve("rust/ui/target/release/examples", `ui-contract${process.platform === "win32" ? ".exe" : ""}`);
function native(ops) {
  assert.ok(existsSync(binary), "build the Rust UI contract example first");
  // JSON.stringify normally erases -0; preserve this specific formatter input
  // so the cross-language fixture exercises the same IEEE-754 value.
  const input = `[${ops.map((op) => Object.is(op.value, -0)
    ? JSON.stringify(op).replace('"value":0', '"value":-0.0') : JSON.stringify(op)).join(",")}]`;
  const result = spawnSync(binary, [], { input, encoding: "utf8", timeout: 15000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function close(actual, expected, context) {
  if (typeof expected === "number") { assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${context}: ${actual} != ${expected}`); return; }
  if (Array.isArray(expected)) { assert.equal(actual.length, expected.length, context); expected.forEach((v, i) => close(actual[i], v, `${context}[${i}]`)); return; }
  if (expected && typeof expected === "object") { assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort()); for (const [k,v] of Object.entries(expected)) close(actual[k],v,`${context}.${k}`); return; }
  assert.equal(actual, expected, context);
}

test("Rust SSR/WASM range geometry matches the actual TypeScript across viewport widths and gaps", () => {
  const buckets = [{ min: 0, max: 10 }, { min: 10, max: 50 }, { min: 50, max: null }];
  const ops = [];
  for (const width of [0, 100, 360, 768, 1280]) for (const discrete of [false, true]) for (const edge of ["low", "high"]) for (const value of [0, 5, 9, 10, 25, 49, 50, 75, 99]) {
    ops.push({ op: "range", bounds: { min: 0, max: 99 }, buckets, low: 9, high: 50, edge, discrete, value, position: value/99, width, gap: 6 });
  }
  const actual = native(ops);
  ops.forEach((op, i) => {
    const selection = range.arenaRangeSelection(op.bounds, op.low, op.high);
    const expected = { selection,
      position: range.arenaBucketPosition(op.buckets, op.bounds, op.value, op.edge, op.discrete, op.width, op.gap),
      valueAt: range.arenaBucketValueAtPosition(op.buckets, op.bounds, op.position, op.edge, op.discrete, op.width, op.gap),
      slices: op.buckets.map((bucket) => { const slice=range.arenaHistogramSlice(bucket,selection,op.bounds,op.discrete); return [slice.left,slice.width]; }),
    };
    close(actual[i], expected, `vector ${i}`);
  });
});

test("Rust number formatting agrees with Intl halfExpand for the supported UI languages", () => {
  const values = [0, -0, 1.005, 2.675, 0.0001, -0.0001, -12.345, 999.999, 1234.5, 1234567.891, 1e-10, 1e21, 9.999999999999998];
  const ops=[];
  for (const value of values) for (const decimals of [0, 1, 2, 5]) for (const russian of [false, true]) ops.push({op:"format",value,decimals,russian});
  const actual=native(ops);
  ops.forEach((op,i)=>assert.equal(actual[i],op.value.toLocaleString(op.russian?"ru-RU":"en-US",{minimumFractionDigits:op.decimals,maximumFractionDigits:op.decimals}),`format ${i}`));
});

function readOriginal(query) {
  const source=readFileSync("components/ArenaAverage.tsx","utf8");
  const tree=ts.createSourceFile("ArenaAverage.tsx",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const names=["defaultFilter","defaultFilters","filterKey","readStatistic","readSelectedMode","readFilter","numericFilterValue","filterIsInvalid","requestFor","contextRequestFor"];
  const functions=tree.statements.filter((node)=>ts.isFunctionDeclaration(node)&&names.includes(node.name?.text)).map((node)=>node.getText(tree));
  assert.equal(functions.length,names.length);
  const code=ts.transpileModule(`const FILTER_FIELDS=["minHours","maxHours","minMatches","maxMatches"];const DEFAULT_MIN_MATCHES="10";${functions.join("\n")}`,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const run=new Function("window","ARENA_MODE_KEYS","ARENA_METRIC_KEYS","URLSearchParams",`${code};const mode=readSelectedMode();const statistic=readStatistic();const filter=readFilter(mode);return {selected:ARENA_MODE_KEYS.indexOf(mode),statistic,invalid:filterIsInvalid(filter),request:requestFor(mode,filter,statistic),context:contextRequestFor(mode,statistic,filter.dimension)};`);
  return run({location:{search:`?${query}`}},ARENA_MODE_KEYS,ARENA_METRIC_KEYS,URLSearchParams);
}
test("Rust reads initial Arena state and filter requests like the current component",()=>{
  const queries=["","arenaMode=lastHero&arenaStatistic=median&arena_lastHero_dimension=hours&arena_lastHero_minHours=0x10", "arenaMode=bad&arenaMode=lastHero&arena_teamFight_metric=win_rate", "arenaMode=blastGang&arena_blastGang_minMatches=bad", "arena_teamFight_minHours=20&arena_teamFight_maxHours=10", "arena_teamFight_minMatches=&arena_teamFight_maxMatches=100", "arenaMode=shootOutDuo&arena_shootOutDuo_metric=damage_per_match&arena_shootOutDuo_minHours=%EF%BB%BF", "arena_teamFight_minHours=-0"];
  queries.push(
    "arenaMode=lastHero&arenaStatistic=median",
    "?arenaMode=lastHero&arenaStatistic=median",
    "?arenaMode=lastHero&arenaMode=checkpoint&arenaStatistic=median&arenaStatistic=trimmed_mean",
    "?arena_lastHero_minHours=12&arena_lastHero_minHours=99&arenaMode=lastHero&arenaStatistic=median",
    "?arena_lastHero_minHours=&arena_lastHero_minHours=99&arenaMode=lastHero&arenaStatistic=median",
    "?", "??arenaMode=lastHero", "?%3FarenaMode=lastHero",
  );
  const ops=queries.map((query)=>({op:"state",query})); const actual=native(ops);
  queries.forEach((query,i)=>assert.deepEqual(actual[i],readOriginal(query),query));
});
