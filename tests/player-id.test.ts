/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript test runner requires explicit .ts imports.
import assert from "node:assert/strict";
import test from "node:test";
import { parsePlayerId, parsePlayerInput } from "../lib/player-id.ts";
import {
  appRouteMode,
  gameModeFromAppRoute,
  seasonalCycleForNavigation,
} from "../types/seasonal.ts";

test("profile links preserve their game mode", () => {
  assert.deepEqual(parsePlayerInput("https://tarkov.dev/players/arena/5869253"), {
    aid: 5869253,
    mode: "arena",
  });
  assert.deepEqual(parsePlayerInput("/players/pve/5869253?foo=1"), {
    aid: 5869253,
    mode: "pve",
  });
  assert.deepEqual(parsePlayerInput("https://tarkov.dev/players/regular/5869253#stats"), {
    aid: 5869253,
    mode: "regular",
  });
  assert.deepEqual(parsePlayerInput("https://tarkov.dev/players/pvp-season/5869253"), {
    aid: 5869253,
    mode: "seasonal",
  });
  assert.equal(parsePlayerInput("https://tarkov.dev/players/season/5869253"), null);
  assert.equal(parsePlayerInput("https://tarkov.dev/players/seasonal/5869253"), null);
});

test("bare ids remain regular and id-only callers stay compatible", () => {
  assert.deepEqual(parsePlayerInput("5869253"), { aid: 5869253, mode: "regular" });
  assert.equal(parsePlayerId("https://tarkov.dev/players/arena/5869253"), 5869253);
  assert.equal(parsePlayerInput("https://tarkov.dev/players/unknown/5869253"), null);
});

test("application routes expose only the canonical pvp-season slug", () => {
  assert.equal(appRouteMode("seasonal"), "pvp-season");
  assert.equal(gameModeFromAppRoute("pvp-season"), "seasonal");
  assert.equal(gameModeFromAppRoute("season"), null);
  assert.equal(gameModeFromAppRoute("seasonal"), null);
});

test("regular profile identity never becomes a Seasonal cycle", () => {
  assert.equal(seasonalCycleForNavigation("regular", "persistent", null, "persistent"), null);
  assert.equal(seasonalCycleForNavigation("pve", "persistent", null, null), null);
  assert.equal(seasonalCycleForNavigation("seasonal", "persistent", null, null), null);
  assert.equal(
    seasonalCycleForNavigation("seasonal", "kord-breach-s1", null, null),
    "kord-breach-s1",
  );
  assert.equal(
    seasonalCycleForNavigation("regular", "persistent", "kord-breach-s1", null),
    "kord-breach-s1",
  );
  assert.equal(
    seasonalCycleForNavigation("seasonal", undefined, null, "kord-breach-s1"),
    "kord-breach-s1",
  );
});
