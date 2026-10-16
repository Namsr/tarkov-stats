import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const state = { loads: [], excluded: false, failure: false };
globalThis.leaderboardPreviewRouteTest = state;
const stubs = {
  "@/lib/leaderboard/preview": `export async function loadLeaderboardPreview(aid, scope) {
    const state = globalThis.leaderboardPreviewRouteTest; state.loads.push({ aid, ...scope });
    if (state.failure) throw new Error('storage unavailable'); return { aid, ...scope };
  }`,
  "@/lib/leaderboard/runtime": `export async function leaderboardRuntime() {
    return { reader: { excluded: () => globalThis.leaderboardPreviewRouteTest.excluded } };
  }`,
};
registerHooks({ resolve(specifier, context, nextResolve) {
  if (stubs[specifier]) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}` };
  if (specifier === "next/server") return nextResolve("next/server.js", context);
  if (specifier.startsWith("@/")) return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
  return nextResolve(specifier, context);
} });

const { GET } = await import("../app/api/leaderboard/preview/route.ts");
const { NextRequest } = await import("next/server");
const drive = (query, ip = "preview-test") => GET(new NextRequest(`http://localhost/api/leaderboard/preview?${query}`, { headers: { "x-real-ip": ip } }));

test("preview rejects invalid identities before opening storage", async () => {
  for (const query of ["aid=-1&mode=regular", "aid=NaN&mode=regular", "aid=1&mode=other", "aid=1&mode=arena&arenaMode=other", "aid=1&mode=regular&cycle=other", "aid=1&mode=regular&arenaMode=blastGang"]) {
    assert.equal((await drive(query)).status, 400);
  }
  assert.equal(state.loads.length, 0);
});

test("preview reads only the validated mode and respects live exclusions", async () => {
  const response = await drive("aid=42&mode=arena&arenaMode=lastHero");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { aid: 42, mode: "arena", arenaMode: "lastHero", cycleId: null });
  state.excluded = true;
  const before = state.loads.length;
  assert.equal((await drive("aid=42&mode=regular")).status, 404);
  assert.equal(state.loads.length, before);
  state.excluded = false;
});

test("storage failures remain uncacheable", async () => {
  state.failure = true;
  const response = await drive("aid=42&mode=regular", "storage-test");
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  state.failure = false;
});

test("preview rate limiting stops storage work", async () => {
  const { checkRateLimit } = await import("../lib/rate-limiter.ts");
  // Use the same configured proxy header as the route.
  const { getClientIp } = await import("../lib/client-ip.ts");
  const request = new NextRequest("http://localhost/", { headers: { "x-real-ip": "preview-test" } });
  const ip = getClientIp(request);
  for (let i = 0; i < 30; i++) checkRateLimit(ip, { bucket: "leaderboard-preview", max: 30 });
  const before = state.loads.length;
  const limited = await drive("aid=42&mode=regular");
  assert.equal(limited.status, 429);
  assert.equal(state.loads.length, before);
  assert.equal(limited.headers.get("Cache-Control"), "no-store");
});
