import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const state = { ready: true, result: { series: {} }, failure: null, calls: [], keys: [], timings: [] };
globalThis.metricSeriesTest = state;
const stubs = {
  "@/lib/observability/request-timing": `export function createRequestTiming() { return {
    setRequestContext() {}, now: Date.now, elapsedMs: (start)=>Date.now()-start,
    finish: (input)=>globalThis.metricSeriesTest.timings.push(input),
  }; }`,
  "@/lib/seasonal/config": `export function isSeasonalRolloutReady() { return globalThis.metricSeriesTest.ready; }
    export function loadSeasonalCycleConfig() { return { cycleId: "s1" }; }`,
  "@/lib/cohort-worker": `export async function computeCohortInBackground(job) { const s = globalThis.metricSeriesTest; s.calls.push(job); if (s.failure) throw s.failure; return s.result; }`,
  "@/lib/average-publication": `export async function readAveragePublication() { return { generation: 42 }; }
    export function seasonalPublicationScope(cycle) { return "seasonal:"+cycle; }
    export function standardAverageVariant(stat,period) { return stat+":"+period; }`,
  "@/lib/average-dynamic-cache": `export async function loadDynamicAverage(key,loader,now,options) {
    globalThis.metricSeriesTest.keys.push([key, options.fallbackKey]); return { value: await loader(), cache: "miss" }; }
    export function statisticsCacheHeaders() { return { "Cache-Control": "no-store", "X-Statistics-Stale": "0" }; }`,
};
registerHooks({ resolve(specifier,context,nextResolve) {
  if (stubs[specifier]) return { shortCircuit: true, url: "data:text/javascript,"+encodeURIComponent(stubs[specifier]) };
  if (specifier === "next/server") return nextResolve("next/server.js", context);
  if (specifier.startsWith("@/")) return { shortCircuit: true, url: pathToFileURL(resolve(specifier.slice(2)+".ts")).href };
  return nextResolve(specifier,context);
} });
const { GET } = await import("../app/api/average/metrics/route.ts");
const { NextRequest } = await import("next/server");
const drive = (query,ip="metric-series-test") => GET(new NextRequest("http://localhost/api/average/metrics?"+query,{headers:{"x-real-ip":ip}}));

test("metric series validates fixed request shape and Seasonal rollout before computation", async () => {
  for (const query of ["mode=arena", "statistic=avg", "period=7d", "dimension=hours", "metric=kd_ratio", "min=0", "mode=pve&cycle=s1", "mode=seasonal&cycle=s2", "mode=seasonal", "mode=seasonal&cycle=s1&cycle=s1", "mode=pve&mode=regular"]) {
    assert.equal((await drive(query)).status,400,query);
  }
  state.ready=false;
  assert.equal((await drive("mode=seasonal&cycle=s1")).status,404);
  state.ready=true;
  assert.equal(state.calls.length,0);
});

test("all modes, periods and statistics dispatch one batch and isolate generation and fallback keys", async () => {
  for (const mode of ["regular","pve","seasonal"]) for (const statistic of ["median","trimmed_mean"]) for (const period of ["all","90d"]) {
    const cycleId=mode==="seasonal"?"s1":"persistent";
    const response=await drive(new URLSearchParams({mode,statistic,period,...(mode==="seasonal"?{cycle:cycleId}:{})}).toString());
    assert.equal(response.status,200);
    assert.equal(state.timings.at(-1).mode,mode); assert.equal(state.timings.at(-1).operation,"average");
    assert.equal(state.timings.at(-1).cache,"miss"); assert.ok(state.timings.at(-1).averagesMs>=0);
    assert.deepEqual(state.calls.at(-1),{kind:"average_metrics",args:[{mode,statistic,period,cycleId}]});
    const [key,fallback]=state.keys.at(-1); assert.deepEqual(JSON.parse(key),[fallback,42]);
    assert.deepEqual(JSON.parse(fallback),["metric-series-v1",mode,cycleId,statistic,period]);
  }
});

test("unavailable storage, queue and timeout retry; calculation errors remain500", async () => {
  state.result=null;
  let response=await drive("mode=regular"); assert.equal(response.status,503); assert.equal(response.headers.get("Retry-After"),"5");
  state.result={series:{}};
  for (const name of ["ComputeUnavailableError","DynamicComputeTimeoutError"]) {
    state.failure=Object.assign(new Error("fixture"),{name}); response=await drive("mode=pve");
    assert.equal(response.status,503); assert.equal(response.headers.get("Retry-After"),"5"); assert.equal(response.headers.get("Cache-Control"),"no-store");
  }
  state.failure=new Error("fixture"); response=await drive("mode=pve"); assert.equal(response.status,500); assert.equal(state.timings.at(-1).outcome,"error"); assert.equal(response.headers.get("Cache-Control"),"no-store"); state.failure=null;
});

test("metric series shares the sibling rate budget and stops before compute", async () => {
  const { checkRateLimit }=await import("../lib/rate-limiter.ts"); const {getClientIp}=await import("../lib/client-ip.ts");
  for (const [mode,max,bucket] of [["pve",300,"average"],["seasonal",480,"seasonal-average"]]) {
    const ip="series-budget-"+mode; const request=new NextRequest("http://localhost/",{headers:{"x-real-ip":ip}});
    for(let i=0;i<max;i++) checkRateLimit(getClientIp(request),{bucket,max});
    const before=state.calls.length; const response=await drive("mode="+mode+(mode==="seasonal"?"&cycle=s1":""),ip);
    assert.equal(response.status,429); assert.equal(response.headers.get("Cache-Control"),"no-store"); assert.equal(state.calls.length,before);
  }
});
