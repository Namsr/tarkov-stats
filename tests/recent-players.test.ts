/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript test runner requires explicit .ts imports.
import assert from "node:assert/strict";
import test from "node:test";
import {
  getRecentPlayerHref,
  MAX_RECENT_PLAYERS,
  readRecentPlayers,
  removeRecentPlayer,
  upsertRecentPlayer,
  filterRecentPlayers,
} from "../lib/recent-players.ts";

let cookieValue = "";
let writes: string[] = [];

function installBrowser(protocol = "http:") {
  cookieValue = "";
  writes = [];
  const documentMock = {};
  Object.defineProperty(documentMock, "cookie", {
    configurable: true,
    get: () => cookieValue,
    set: (value: string) => {
      writes.push(value);
      cookieValue = value;
    },
  });
  Object.defineProperty(globalThis, "document", { configurable: true, value: documentMock });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { protocol } },
  });
}

function uninstallBrowser() {
  delete globalThis.document;
  delete globalThis.window;
}

function setPayload(payload: unknown) {
  cookieValue = `recent_players=${encodeURIComponent(JSON.stringify(payload))}`;
}

test.afterEach(uninstallBrowser);

test("returns an empty history for missing, malformed, and unsupported cookie payloads", () => {
  installBrowser();

  assert.deepEqual(readRecentPlayers(), []);

  cookieValue = "recent_players=%E0%A4%A";
  assert.deepEqual(readRecentPlayers(), []);

  cookieValue = `recent_players=${encodeURIComponent("{not valid JSON")}`;
  assert.deepEqual(readRecentPlayers(), []);

  setPayload({ v: 2, items: [{ aid: "42", nickname: "Player", mode: "regular" }] });
  assert.deepEqual(readRecentPlayers(), []);
});

test("reads the versioned cookie, drops malformed rows, and keeps first AID occurrence", () => {
  installBrowser();
  setPayload({
    v: 1,
    items: [
      { aid: "42", nickname: "First", mode: "regular", cycle: "ignored" },
      { aid: "42", nickname: "Duplicate", mode: "arena" },
      { aid: "43", nickname: "Season", mode: "pvp-season", cycle: "wipe-1" },
      { aid: "44", nickname: "PvE", mode: "pve", cycle: "ignored" },
      { aid: "not-an-aid", nickname: "Bad", mode: "regular" },
      { aid: "45", nickname: "Bad mode", mode: "unknown" },
      { aid: "46", nickname: "", mode: "regular" },
    ],
  });

  assert.deepEqual(readRecentPlayers(), [
    { aid: "42", nickname: "First", mode: "regular" },
    { aid: "43", nickname: "Season", mode: "pvp-season", cycle: "wipe-1" },
    { aid: "44", nickname: "PvE", mode: "pve" },
  ]);
});

test("upsert is newest-first, deduplicated, capped, and writes browser-safe cookie flags", () => {
  installBrowser();
  setPayload({
    v: 1,
    items: Array.from({ length: MAX_RECENT_PLAYERS }, (_, index) => ({
      aid: String(index + 1),
      nickname: `Player${index + 1}`,
      mode: "regular",
    })),
  });

  const next = upsertRecentPlayer({ aid: "5", nickname: "Seasonal", mode: "pvp-season", cycle: "wipe-2" });

  assert.equal(next.length, MAX_RECENT_PLAYERS);
  assert.deepEqual(next[0], { aid: "5", nickname: "Seasonal", mode: "pvp-season", cycle: "wipe-2" });
  assert.equal(next.filter((entry) => entry.aid === "5").length, 1);
  assert.equal(next.at(-1)?.aid, "10");
  assert.match(writes.at(-1), /Max-Age=15552000/);
  assert.match(writes.at(-1), /Path=\//);
  assert.match(writes.at(-1), /SameSite=Lax/);
  assert.doesNotMatch(writes.at(-1), /HttpOnly/);
  assert.doesNotMatch(writes.at(-1), /Secure/);
  assert.deepEqual(readRecentPlayers(), next);
});

test("adds Secure only for HTTPS and remove rewrites the remaining history", () => {
  installBrowser("https:");
  const added = upsertRecentPlayer({ aid: "42", nickname: "One", mode: "regular" });
  upsertRecentPlayer({ aid: "43", nickname: "Two", mode: "arena" });
  assert.match(writes.at(-1), /; Secure$/);

  assert.deepEqual(removeRecentPlayer("42"), [
    { aid: "43", nickname: "Two", mode: "arena" },
  ]);
  assert.equal(added[0].aid, "42");
  assert.equal(readRecentPlayers()[0].aid, "43");
});

test("filter is case-insensitive, substring-based, and non-mutating", () => {
  const entries = [
    { aid: "1", nickname: "Alpha", mode: "regular" },
    { aid: "2", nickname: "Bravo", mode: "pve" },
    { aid: "3", nickname: "ALPHABET", mode: "arena" },
  ];

  assert.deepEqual(filterRecentPlayers(entries, "pha"), [entries[0], entries[2]]);
  assert.deepEqual(filterRecentPlayers(entries, ""), entries);
  assert.notEqual(filterRecentPlayers(entries, ""), entries);
});

test("builds canonical player routes and seasonal cycle query", () => {
  assert.equal(getRecentPlayerHref({ aid: "1", nickname: "A", mode: "regular" }), "/player/regular/1");
  assert.equal(getRecentPlayerHref({ aid: "2", nickname: "B", mode: "pve" }), "/player/pve/2");
  assert.equal(getRecentPlayerHref({ aid: "3", nickname: "C", mode: "arena" }), "/player/arena/3");
  assert.equal(
    getRecentPlayerHref({ aid: "4", nickname: "D", mode: "pvp-season", cycle: "wipe-1" }),
    "/player/pvp-season/4?cycle=wipe-1",
  );
  assert.equal(getRecentPlayerHref({ aid: "5", nickname: "E", mode: "pvp-season" }), "/player/pvp-season/5");
});
