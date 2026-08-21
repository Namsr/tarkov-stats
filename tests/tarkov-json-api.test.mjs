import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  expToLevel,
  getAchievements,
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
  const [api, seasonal, index, seasonalProfiles, seasonalIndex] = await Promise.all([
    readFile("lib/tarkov-api.ts", "utf8"),
    readFile("lib/seasonal/fetch.ts", "utf8"),
    readFile("scripts/sync-player-index.mjs", "utf8"),
    readFile("scripts/sync-seasonal-profiles.mjs", "utf8"),
    readFile("scripts/sync-seasonal-index.mjs", "utf8"),
  ]);
  assert.doesNotMatch(api + seasonal + seasonalProfiles + seasonalIndex, /api\.tarkov\.dev\/graphql|\bgraphql\b/i);
  assert.equal((api.match(/\bfetch\s*\(/g) ?? []).length, 1);
  assert.doesNotMatch(seasonal, /\bfetch\s*\(/);
  assert.match(api, /TarkovStats\/0\.1 \(\+https:\/\/tarkovstats\.ru\)/);
  assert.match(index, /TarkovStats\/0\.1 \(\+https:\/\/tarkovstats\.ru\)/);
  assert.match(seasonalProfiles, /fetchTarkovJson/);
  assert.match(seasonalIndex, /fetchTarkovJson/);
});

test("Seasonal achievement metadata uses the pvp-season JSON dataset", async () => {
  const originalFetch = globalThis.fetch;
  const originalCacheDir = process.env.ACHIEVEMENTS_CACHE_DIR;
  const cacheDir = await mkdtemp(join(tmpdir(), "tarkov-achievements-"));
  process.env.ACHIEVEMENTS_CACHE_DIR = cacheDir;
  const requested = [];
  const payload = {
    data: { achievements: {
      "6a5df324129316dcbe0da3da": {
        id: "6a5df324129316dcbe0da3da",
        name: "6a5df324129316dcbe0da3da name",
        normalizedName: "i-had-a-plan",
        side: "All", normalizedRarity: "seasonal", playersCompletedPercent: 1,
        adjustedPlayersCompletedPercent: 2,
      },
    } },
  };
  globalThis.fetch = async (input) => {
    requested.push(String(input));
    if (String(input).endsWith("/tasks")) return new Response(JSON.stringify(payload));
    if (String(input).endsWith("/tasks_en")) {
      return new Response(JSON.stringify({ data: { "6a5df324129316dcbe0da3da name": "I Had a Plan" } }));
    }
    if (String(input).endsWith("/tasks_ru")) {
      return new Response(JSON.stringify({ data: { "6a5df324129316dcbe0da3da name": "У меня был план и я его придерживался" } }));
    }
    return new Response(null, { status: 404 });
  };
  try {
    const coldApi = await import(`../lib/tarkov-api.ts?seasonal-rarity=${Date.now()}`);
    assert.equal(coldApi.getCachedAchievements("seasonal"), null);
    const map = await coldApi.getAchievements("seasonal");
    const achievement = map.get("6a5df324129316dcbe0da3da");
    assert.equal(achievement?.nameEn, "I Had a Plan");
    assert.equal(achievement?.nameRu, "У меня был план и я его придерживался");
    assert.equal(achievement?.rarity, "seasonal");
    assert.deepEqual(requested, [
      "https://json.tarkov.dev/pvp-season/tasks",
      "https://json.tarkov.dev/pvp-season/tasks_en",
      "https://json.tarkov.dev/pvp-season/tasks_ru",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCacheDir === undefined) delete process.env.ACHIEVEMENTS_CACHE_DIR;
    else process.env.ACHIEVEMENTS_CACHE_DIR = originalCacheDir;
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("last-good achievement metadata survives an upstream outage", async () => {
  const originalFetch = globalThis.fetch;
  const originalCacheDir = process.env.ACHIEVEMENTS_CACHE_DIR;
  const originalNow = Date.now;
  const cacheDir = await mkdtemp(join(tmpdir(), "tarkov-achievements-"));
  process.env.ACHIEVEMENTS_CACHE_DIR = cacheDir;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  const payload = { data: { achievements: {
    persisted: {
      id: "persisted", name: "persisted title", normalizedName: "persisted-title",
      side: "All", normalizedRarity: "common", playersCompletedPercent: 3,
      adjustedPlayersCompletedPercent: 4,
    },
  } } };
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/tasks")) return new Response(JSON.stringify(payload));
    if (url.endsWith("/tasks_en")) {
      return new Response(JSON.stringify({ data: { "persisted title": "Persisted title" } }));
    }
    if (url.endsWith("/tasks_ru")) {
      return new Response(JSON.stringify({ data: { "persisted title": "Сохранённое достижение" } }));
    }
    return new Response(null, { status: 404 });
  };
  try {
    const first = await getAchievements("regular");
    assert.equal(first.get("persisted")?.nameEn, "Persisted title");
    now += 7 * 60 * 60 * 1000;
    globalThis.fetch = async () => { throw new Error("upstream unavailable"); };
    // A cache-busted module import gives this test a fresh in-process cache,
    // matching the state after a container restart.
    const restartedApi = await import(`../lib/tarkov-api.ts?restart=${now}`);
    const fallback = await restartedApi.getAchievements("regular");
    assert.equal(fallback.get("persisted")?.nameEn, "Persisted title");
    assert.equal(fallback.get("persisted")?.nameRu, "Сохранённое достижение");
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    if (originalCacheDir === undefined) delete process.env.ACHIEVEMENTS_CACHE_DIR;
    else process.env.ACHIEVEMENTS_CACHE_DIR = originalCacheDir;
    await rm(cacheDir, { recursive: true, force: true });
  }
});
