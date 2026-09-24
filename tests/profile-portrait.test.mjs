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
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const aid = Number(new URL(url).pathname.match(/(\d+)\.json$/)[1]);
    calls.push(String(url));
    assert.equal(new Headers(init.headers).get("User-Agent"), "tarkovstats.ru");
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
  assert.equal((await request("aid=42&mode=seasonal&cycle=old")).status, 404);
  assert.equal(calls.length, 0);
  for (const mode of ["regular", "pve", "arena", "seasonal"]) {
    const response = await request(`aid=42&mode=${mode}&cycle=portrait-test`);
    assert.equal(response.status, 307);
    assert.equal(new URL(response.headers.get("location")).hostname, "imagemagic.tarkov.dev");
    assert.match(response.headers.get("cache-control"), /max-age=300/);
  }
  assert.deepEqual(calls, ["profile", "pve", "arena", "pvp-season"].map((path) => `https://players.tarkov.dev/${path}/42.json`));
  await request("aid=42&mode=pve");
  assert.equal(calls.length, 4, "cached portraits must not refetch the profile");
  for (const [aid, status] of [[91, 404], [92, 502], [93, 404]]) {
    const response = await request(`aid=${aid}&mode=regular`);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("location"), null);
  }
});
