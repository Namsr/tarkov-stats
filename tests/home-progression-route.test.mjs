import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const fixture = { result: null, ready: true, calls: [] };
globalThis.__homeProgressionRoute = fixture;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier === "@/lib/seasonal/progression-cache") return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`
      export async function getCachedProgressionTimeline(...args) {
        globalThis.__homeProgressionRoute.calls.push(args);
        return globalThis.__homeProgressionRoute.result;
      }` )}` };
    if (specifier === "@/lib/seasonal/config") return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`
      export const isSeasonalRolloutReady = () => globalThis.__homeProgressionRoute.ready;
      export const loadSeasonalCycleConfig = () => ({ cycleId: "s1" });` )}` };
    if (specifier.startsWith("@/")) return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
    return nextResolve(specifier, context);
  },
});
const { NextRequest } = await import("next/server");
const { GET } = await import("../app/api/progression/timeline/route.ts");
const request = (query) => new NextRequest(`http://localhost/api/progression/timeline?${query}`, {
  headers: { "Accept-Encoding": "identity" },
});

test("timeline route preserves the default contract and serves compact personal history for home", async () => {
  for (const mode of ["regular", "pve", "seasonal"]) {
    const cycleId = mode === "seasonal" ? "s1" : "persistent";
    const point = { pmcRaids: 10, value: 50, level: 5, seriesId: 1, observedAt: 1000, pointId: "1", n: 1 };
    const series = { player: [point], nearby: [point], overall: [point] };
    const timeline = { identity: { aid: 42, mode, cycleId }, metrics: { xp: series, survival: series, ai_kd: series },
      risk: { data: "risk" }, longTerm: { data: "details" }, n: 10, confidence: 1 };
    fixture.result = { status: "ready", timeline, stale: true, generatedAt: 1000 };
    fixture.calls = [];
    const query = new URLSearchParams({ mode, cycle: cycleId, aid: "42" });
    const full = await GET(request(query));
    const compact = await GET(request(`${query}&view=home`));
    assert.equal(full.status, 200);
    assert.equal(compact.status, 200);
    assert.deepEqual(await full.json(), timeline);
    const body = await compact.json();
    assert.deepEqual(body, { identity: timeline.identity, metrics: {
      xp: { player: [{ pmcRaids: 10, value: 50, level: 5, seriesId: 1, observedAt: 1000 }] },
      survival: { player: [{ pmcRaids: 10, value: 50, level: 5, seriesId: 1, observedAt: 1000 }] },
    } });
    for (const header of ["cache-control", "x-statistics-stale", "x-statistics-generated-at", "vary"]) {
      assert.equal(compact.headers.get(header), full.headers.get(header), header);
    }
    assert.equal(compact.headers.get("x-statistics-stale"), "1");
    assert.deepEqual(fixture.calls, [[mode, cycleId, 42], [mode, cycleId, 42]]);
  }
});

test("compact timelines retain input validation, rollout gates and unavailable responses", async () => {
  for (const query of ["mode=regular&cycle=persistent&aid=0&view=home",
    "mode=regular&cycle=persistent&aid=42&view=home&view=home",
    "mode=regular&cycle=persistent&aid=42&view=other"]) {
    fixture.calls = [];
    const response = await GET(request(query));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(fixture.calls, []);
  }
  fixture.ready = false;
  fixture.calls = [];
  assert.equal((await GET(request("mode=seasonal&cycle=s1&aid=42&view=home"))).status, 404);
  fixture.ready = true;
  assert.equal((await GET(request("mode=seasonal&cycle=s2&aid=42&view=home"))).status, 404);
  assert.deepEqual(fixture.calls, []);
  for (const [status, expected] of [["not-found", 404], ["unavailable", 503]]) {
    fixture.result = { status };
    const response = await GET(request("mode=regular&cycle=persistent&aid=42&view=home"));
    assert.equal(response.status, expected);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});
