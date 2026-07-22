import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  expToLevel,
  loadPlayerLevels,
  parseAchievements,
  parsePlayerLevels,
  fetchTarkovJson,
  TARKOV_JSON_USER_AGENT,
} from "../lib/tarkov-api.ts";

test("playerLevels validation, ordering and incremental XP boundaries", () => {
  const levels = parsePlayerLevels({
    data: { playerLevels: [{ level: 3, exp: 20 }, { level: 1, exp: 0 }, { level: 2, exp: 10 }] },
  });
  assert.deepEqual(levels, [
    { level: 1, exp: 0 }, { level: 2, exp: 10 }, { level: 3, exp: 20 },
  ]);
  assert.equal(expToLevel(9, levels), 1);
  assert.equal(expToLevel(10, levels), 2);
  assert.equal(expToLevel(29, levels), 2);
  assert.equal(expToLevel(30, levels), 3);
  assert.throws(
    () => parsePlayerLevels({ data: { playerLevels: [{ level: 1, exp: 0 }, { level: 1, exp: 1 }] } }),
    /duplicate level/
  );
  assert.throws(
    () => parsePlayerLevels({ data: { playerLevels: [{ level: 1, exp: Number.NaN }] } }),
    /finite non-negative/
  );
});

test("versioned fallback handles network, HTTP and malformed JSON failures", async () => {
  const failures = [
    async () => { throw new Error("offline"); },
    async () => new Response(null, { status: 503 }),
    async () => new Response("not json", { status: 200 }),
  ];
  for (const request of failures) {
    const levels = await loadPlayerLevels(request);
    assert.equal(expToLevel(2_935_114, levels), 36);
    assert.equal(levels.at(-1)?.level, 79);
  }
});

test("achievement object uses English translation, normalized fallbacks and normalized rarity", () => {
  const achievementsPayload = { data: { achievements: {
    a: {
      id: "a", name: "a name", normalizedName: "alpha-slug", side: "Pmc",
      normalizedRarity: "common", playersCompletedPercent: 10,
      adjustedPlayersCompletedPercent: 20,
    },
    b: {
      id: "b", name: "missing name", normalizedName: "bravo-slug", side: "Pmc",
      normalizedRarity: "rare", playersCompletedPercent: 5,
      adjustedPlayersCompletedPercent: 8,
    },
    c: {
      id: "c", side: "All", normalizedRarity: "legendary",
      playersCompletedPercent: 1, adjustedPlayersCompletedPercent: 2,
    },
  } } };
  const map = parseAchievements(achievementsPayload, { data: { "a name": "Alpha", "missing name": "" } });
  assert.equal(map.get("a")?.name, "Alpha");
  assert.equal(map.get("b")?.name, "bravo-slug");
  assert.equal(map.get("c")?.name, "c");
  assert.equal(map.get("b")?.rarity, "rare");
  assert.throws(
    () => parseAchievements(achievementsPayload, { data: {} }),
    /must contain translations/
  );
});

test("shared client always sends the project JSON headers", async () => {
  const originalFetch = globalThis.fetch;
  let headers;
  globalThis.fetch = async (_input, init) => {
    headers = new Headers(init?.headers);
    return new Response("{}", { status: 200 });
  };
  try {
    await fetchTarkovJson("https://players.tarkov.dev/profile/1.json", {
      headers: { Accept: "text/plain", "User-Agent": "wrong" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(headers?.get("Accept"), "application/json");
  assert.equal(headers?.get("User-Agent"), TARKOV_JSON_USER_AGENT);
});

test("server sources contain no GraphQL calls and use the shared project identity", async () => {
  const [api, seasonal, index] = await Promise.all([
    readFile("lib/tarkov-api.ts", "utf8"),
    readFile("lib/seasonal/fetch.ts", "utf8"),
    readFile("scripts/sync-player-index.mjs", "utf8"),
  ]);
  assert.doesNotMatch(api + seasonal, /api\.tarkov\.dev\/graphql|\bgraphql\b/i);
  assert.equal((api.match(/\bfetch\s*\(/g) ?? []).length, 1);
  assert.doesNotMatch(seasonal, /\bfetch\s*\(/);
  assert.match(api, /TarkovStats\/0\.1 \(\+https:\/\/tarkovstats\.ru\)/);
  assert.match(index, /TarkovStats\/0\.1 \(\+https:\/\/tarkovstats\.ru\)/);
});
