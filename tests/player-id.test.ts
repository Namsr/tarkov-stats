/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript test runner requires explicit .ts imports.
import assert from "node:assert/strict";
import test from "node:test";
import { parsePlayerId, parsePlayerInput } from "../lib/player-id.ts";

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
});

test("bare ids remain regular and id-only callers stay compatible", () => {
  assert.deepEqual(parsePlayerInput("5869253"), { aid: 5869253, mode: "regular" });
  assert.equal(parsePlayerId("https://tarkov.dev/players/arena/5869253"), 5869253);
  assert.equal(parsePlayerInput("https://tarkov.dev/players/unknown/5869253"), null);
});
