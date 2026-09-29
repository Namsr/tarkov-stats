import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { profilePortraitUrl } from "../lib/profile-portrait.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier === "next/cache") {
      return { shortCircuit: true, url: pathToFileURL(resolve("tests/fixtures/next-cache-shim.mjs")).href };
    }
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
    }
    try { return nextResolve(specifier, context); } catch (error) {
      if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

const { GET } = await import("../app/api/player/portrait/route.ts");
const { NextRequest } = await import("next/server");
const customization = {
  head: "68fb88b9d4b0e9617502c1c4", body: "5cc0858d14c02e000c6bea66",
  feet: "5cc085bb14c02e000e67a5c5", hands: "5cc0876314c02e000c6bea6b",
};
const equipment = { Id: "root", Items: [{ _id: "helmet", _tpl: "5b432d215acfc4771e1c6624", parentId: "root", slotId: "Headwear" }] };
const imageBytes = Uint8Array.from([82, 73, 70, 70, 0, 255, 128, 0, 87, 69, 66, 80]);
const profile = (aid) => ({ aid, customization, equipment, info: { nickname: "Player" }, pmcStats: {} });
const request = (query) => GET(new NextRequest(`http://localhost/api/player/portrait?${query}`));

test("portrait render carries the character and equipment, excluding unrelated profile data", () => {
  const url = new URL(profilePortraitUrl(profile(42), 42));
  assert.equal(url.origin, "https://imagemagic.tarkov.dev");
  assert.equal(url.pathname, "/player/42.webp");
  assert.deepEqual(JSON.parse(url.searchParams.get("data")), { aid: 42, customization, equipment });
  assert.equal(profilePortraitUrl(profile(43), 42), null);
  for (const value of [null, {}, { ...profile(42), customization: {} }, { ...profile(42), equipment: [] }]) {
    assert.equal(profilePortraitUrl(value, 42), null);
  }
  const arena = new URL(profilePortraitUrl({ ...profile(42), customization: { upperSuitId: "arena-suit" } }, 42));
  assert.equal(JSON.parse(arena.searchParams.get("data")).customization.head, "5cc084dd14c02e000b0550a3");
});

test("portrait route isolates and caches modes, validates cycles, and handles upstream failure", async (t) => {
  const calls = [];
  const renders = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const parsed = new URL(url);
    assert.equal(new Headers(init.headers).get("User-Agent"), "tarkovstats.ru");
    if (parsed.hostname === "imagemagic.tarkov.dev") {
      renders.push(parsed.pathname);
      const rendered = Number(parsed.pathname.match(/(\d+)\.webp$/)[1]);
      const attempt = renders.filter((path) => path === parsed.pathname).length;
      assert.equal(init.cache, "no-store", "only complete images may enter our result cache");
      if (attempt === 1) {
        if (rendered === 95) return new Response("render failed", { status: 500 });
        if (rendered === 96) throw new Error("renderer offline");
        if (rendered === 97) return new Response(new ReadableStream({
          start(controller) { controller.error(new TypeError("image body connection reset")); },
        }), { headers: { "Content-Type": "image/webp" } });
        if (rendered === 98) return new Response("<html>upstream error</html>", { headers: { "Content-Type": "text/html" } });
        if (rendered === 99) return new Response(null, { headers: { "Content-Type": "image/webp" } });
      }
      return new Response(imageBytes, { headers: { "Content-Type": "image/webp" } });
    }
    const aid = Number(parsed.pathname.match(/(\d+)\.json$/)[1]);
    calls.push(String(url));
    if (aid === 91) return new Response(null, { status: 404 });
    if (aid === 92) throw new Error("offline");
    if (aid === 93) return Response.json({ ...profile(aid), aid: 999 });
    return Response.json(profile(aid));
  });
  const env = {
    SEASONAL_ENABLED: "true", SEASONAL_CYCLE_ID: "portrait-test", SEASONAL_STARTS_AT: "2026-01-01",
    SEASONAL_UPSTREAM_CONTRACT: "direct_profile", SEASONAL_UPSTREAM_FIXTURE_CONFIRMED: "true",
    SEASONAL_PROFILE_URL_TEMPLATE: "https://players.tarkov.dev/pvp-season/{aid}.json",
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  for (const query of ["aid=-1&mode=regular", "aid=42&mode=invalid", "mode=regular"]) {
    assert.equal((await request(query)).status, 400);
  }
  // A rollout or cycle mismatch is not a stable answer, so it must not be
  // cacheable: it flips when the cycle window opens or SEASONAL_ENABLED changes.
  const rolloutMiss = await request("aid=42&mode=seasonal&cycle=old");
  assert.equal(rolloutMiss.status, 404);
  assert.match(rolloutMiss.headers.get("cache-control"), /no-store/);
  assert.equal(calls.length, 0);
  for (const mode of ["regular", "pve", "arena", "seasonal"]) {
    const response = await request(`aid=42&mode=${mode}&cycle=portrait-test`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("location"), null, "the browser must receive the image, not another render request");
    assert.equal(response.headers.get("content-type"), "image/webp");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), imageBytes);
    assert.match(response.headers.get("cache-control"), /max-age=300/);
  }
  assert.deepEqual(calls, ["profile", "pve", "arena", "pvp-season"].map((path) => `https://players.tarkov.dev/${path}/42.json`));
  const cached = await request("aid=42&mode=pve");
  assert.equal(cached.status, 200);
  assert.deepEqual(new Uint8Array(await cached.arrayBuffer()), imageBytes);
  assert.equal(calls.length, 4, "cached portraits must not refetch the profile");
  assert.deepEqual(renders, ["/player/42.webp"], "the image bytes must be cached too");

  for (const [aid, failure] of [[95, "HTTP 500"], [96, "network failure"], [97, "body read failure"], [98, "HTML response"], [99, "empty image"]]) {
    await t.test(`${failure} does not cache a missing portrait and recovers on the next request`, async () => {
      const fallback = await request(`aid=${aid}&mode=regular`);
      assert.equal(fallback.status, 307);
      assert.equal(new URL(fallback.headers.get("location")).hostname, "imagemagic.tarkov.dev");
      assert.match(fallback.headers.get("cache-control"), /no-store/);

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const recovered = await request(`aid=${aid}&mode=regular`);
        assert.equal(recovered.status, 200);
        assert.equal(recovered.headers.get("content-type"), "image/webp");
        assert.deepEqual(new Uint8Array(await recovered.arrayBuffer()), imageBytes);
      }
      assert.equal(renders.filter((path) => path === `/player/${aid}.webp`).length, 2, "retry the failure, then reuse the complete image");
    });
  }
  // A missing portrait is a stable answer, so the 404 is cacheable. An upstream
  // failure must not be, or a Cloudflare blip would stick for the whole max-age.
  for (const [aid, status, cacheable] of [[91, 404, true], [92, 502, false], [93, 404, true]]) {
    const response = await request(`aid=${aid}&mode=regular`);
    assert.equal(response.status, status);
    const cacheControl = response.headers.get("cache-control");
    assert.equal(cacheControl.includes("no-store"), !cacheable, `aid=${aid}`);
    if (cacheable) assert.match(cacheControl, /max-age=300/);
    assert.equal(response.headers.get("location"), null);
  }
});
