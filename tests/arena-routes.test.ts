/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript runner needs explicit source hooks.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier === "@/lib/auth/session") {
      return { shortCircuit: true, url: pathToFileURL(resolve("tests/fixtures/favorite-auth-session-shim.mjs")).href };
    }
    if (specifier === "next/cache") {
      return { shortCircuit: true, url: pathToFileURL(resolve("tests/fixtures/next-cache-shim.mjs")).href };
    }
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
    }
    return nextResolve(specifier, context);
  },
});

const directory = mkdtempSync(join(tmpdir(), "tarkov-arena-routes-"));
process.env.SQLITE_PATH = join(directory, "players.db");
process.env.BANS_SQLITE_PATH = join(directory, "bans.db");

const { getFavoritesStore, getStore } = await import("../lib/db.ts");
const { parseArenaProfileStats } = await import("../lib/tarkov-api.ts");
const { getArenaAverage } = await import("../lib/arena/service.ts");
const { GET: getAverage } = await import("../app/api/average/route.ts");
const { GET: getCohort } = await import("../app/api/average/cohort/route.ts");
const { GET: getProfile } = await import("../app/api/player/profile/route.ts");
const { GET: getFavoriteStats } = await import("../app/api/favorites/stats/route.ts");
const { NextRequest } = await import("next/server");

assert.ok(await getStore("arena"));
const db = new DatabaseSync(process.env.SQLITE_PATH);
const modes = ["overall", "teamFight", "lastHero", "checkpoint", "blastGang", "shootOutDuo"];
const insert = db.prepare(`INSERT INTO arena_mode_stats (
  aid, arena_mode, hours, games_count, kd_ratio, win_rate, headshot_rate,
  kills_per_match, damage_per_match, upstream_version, parser_version, raw_json, fetched_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, '{}', 1)`);

for (let aid = 1; aid <= 22; aid += 1) {
  for (const mode of modes) {
    insert.run(aid, mode, 100, 100, aid, 50, 25, 2, 500);
  }
}

const upstreamModeNames = [
  "UnrankedTeamFight",
  "UnrankedLastHero",
  "UnrankedCheckPoint",
  "UnrankedBlastGang",
  "UnrankedShootOutDuo",
];

function arenaCounterGroup(kills = 20, deaths = 10) {
  return { Counters: {
    GamesCount: 20,
    ArenaWins: 12,
    ArenaLoses: 8,
    Kills: kills,
    Deaths: deaths,
    Assists: 3,
    Headshots: 5,
    DamageDealt: 8_000,
    RoundMvpCount: 2,
    MatchMvpCount: 1,
    KillsWithoutDeaths: 3,
    MaxKillsWithoutDeaths: 8,
    WinStreak: 2,
    LongestWinStreak: 6,
    LoseStreak: 1,
    LongestLoseStreak: 4,
  } };
}

function upstreamArenaProfile(aid, updated, nickname) {
  return {
    aid,
    updated,
    info: { nickname, side: "Usec", experience: 0 },
    stat: {
      totalInGameTime: 360_000,
      arenaOverAllCounters: {
        UnrankedOverall: arenaCounterGroup(120, 60),
        ...Object.fromEntries(upstreamModeNames.map((mode, index) => [mode, arenaCounterGroup(20 + index, 10)])),
      },
    },
  };
}

async function storeArenaProfile(profile) {
  const store = await getStore("arena");
  assert.ok(store);
  await store.upsert(profile.aid, parseArenaProfileStats(profile), []);
}

async function withFetch(fetchImpl, action) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function profileRequest(aid, refresh = false) {
  return new NextRequest(`http://local/api/player/profile?aid=${aid}&mode=arena${refresh ? "&refresh=1" : ""}`, {
    headers: { "x-forwarded-for": "198.51.100.90" },
  });
}

test("Arena average validates its isolated query contract and defaults to matches", async () => {
  const response = await getAverage(new NextRequest(
    "http://local/api/average?mode=arena&arenaMode=teamFight",
  ));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.mode, "arena");
  assert.equal(body.schemaVersion, 1);
  assert.deepEqual(body.filterIdentity, {
    mode: "teamFight", statistic: "trimmed_mean", dimension: "matches", metric: "players",
    minHours: null, maxHours: null, minMatches: null, maxMatches: null,
  });
  assert.equal(body.sampleN, 22);

  for (const query of [
    "mode=arena",
    "mode=arena&arenaMode=teamFight&period=90d",
    "mode=arena&arenaMode=teamFight&metric=pmc_kd_ratio",
    "mode=arena&arenaMode=teamFight&dimension=pmc_raids",
    "mode=arena&arenaMode=teamFight&minMatches=-1",
  ]) {
    assert.equal((await getAverage(new NextRequest(`http://local/api/average?${query}`))).status, 400);
  }
});

test("standard Arena mode reads the atomically published response", async () => {
  const publications = await import("../lib/average-publication.ts");
  const previousEnabled = process.env.AVERAGE_PUBLICATIONS_ENABLED;
  const previousPath = process.env.AVERAGE_PUBLICATION_SQLITE_PATH;
  process.env.AVERAGE_PUBLICATIONS_ENABLED = "true";
  process.env.AVERAGE_PUBLICATION_SQLITE_PATH = join(directory, "average-publications.db");
  publications.resetAveragePublicationForTests();
  try {
    const payload = await getArenaAverage({ mode: "teamFight", statistic: "trimmed_mean", dimension: "matches", metric: "players" });
    assert.ok(payload);
    await publications.publishAverageScope("arena", new Map([[
      publications.standardArenaVariant("teamFight", "trimmed_mean"), payload,
    ]]), Date.now() - 10, Date.now());
    const response = await getAverage(new NextRequest(
      "http://local/api/average?mode=arena&arenaMode=teamFight",
    ));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-average-source"), "publication");
    assert.equal((await response.json()).sampleN, 22);
    assert.equal((await getAverage(new NextRequest(
      "http://local/api/average?mode=arena&arenaMode=lastHero",
    ))).status, 503);
  } finally {
    publications.resetAveragePublicationForTests();
    if (previousEnabled === undefined) delete process.env.AVERAGE_PUBLICATIONS_ENABLED;
    else process.env.AVERAGE_PUBLICATIONS_ENABLED = previousEnabled;
    if (previousPath === undefined) delete process.env.AVERAGE_PUBLICATION_SQLITE_PATH;
    else process.env.AVERAGE_PUBLICATION_SQLITE_PATH = previousPath;
  }
});

test("Arena cohort derives both axes from stored Arena data", async () => {
  const response = await getCohort(new NextRequest(
    "http://local/api/average/cohort?mode=arena&aid=1&arenaMode=teamFight&statistic=median",
  ));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.gameMode, "arena");
  assert.equal(body.mode, "teamFight");
  assert.equal(body.strategy, "matched");
  assert.equal(body.schemaVersion, 1);
  assert.deepEqual(body.target, { hours: 100, matches: 100 });
  assert.equal(body.quality, "sufficient");
  assert.equal(body.sampleN, 21);

  const overallResponse = await getCohort(new NextRequest(
    "http://local/api/average/cohort?mode=arena&aid=1&arenaMode=overall&statistic=trimmed_mean",
  ));
  assert.equal(overallResponse.status, 200);
  const overall = await overallResponse.json();
  assert.equal(overall.mode, "overall");
  assert.equal(overall.strategy, "population");
  assert.equal(overall.sampleN, 21);

  assert.equal((await getCohort(new NextRequest(
    "http://local/api/average/cohort?mode=arena&aid=1&arenaMode=teamFight&center=100",
  ))).status, 400);
  assert.equal((await getCohort(new NextRequest(
    "http://local/api/average/cohort?mode=arena&aid=1&arenaMode=teamFight&period=90d",
  ))).status, 400);
});

test("Arena profile returns a normalized stored snapshot without an upstream request", async () => {
  const aid = 40_001;
  await storeArenaProfile(upstreamArenaProfile(aid, 1_800_000_040_001, "Stored Arena"));
  let fetches = 0;

  await withFetch(async () => {
    fetches += 1;
    throw new Error("stored Arena reads must stay offline");
  }, async () => {
    const response = await getProfile(profileRequest(aid));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.profile, null);
    assert.equal(body.arena.nickname, "Stored Arena");
    assert.equal(body.capture.status, "stored");
    assert.equal(body.freshness.fetchedAt, body.arena.fetchedAt);
    assert.ok(Number.isFinite(body.freshness.fetchedAt));
  });
  assert.equal(fetches, 0);
});

test("Arena profile returns a legacy snapshot without waiting for upstream", async () => {
  const aid = 40_002;
  db.prepare(`INSERT INTO mode_players (mode, aid, nickname, fetched_at, stats_json, achievements)
    VALUES ('arena', ?, 'Legacy Arena', 456, ?, '[]')`).run(aid, JSON.stringify({
    nickname: "Legacy Arena", profileUpdatedAt: 1_800_000_040_002,
  }));
  let fetches = 0;

  await withFetch(async () => {
    fetches += 1;
    throw new Error("legacy reads must stay offline");
  }, async () => {
    const response = await getProfile(profileRequest(aid));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.arena, null);
    assert.equal(body.arenaStatus, "legacy_incomplete");
    assert.equal(body.stats.nickname, "Legacy Arena");
    assert.equal(body.freshness.fetchedAt, 456);
  });
  assert.equal(fetches, 0);
});

test("forced Arena refresh preserves a stored snapshot when upstream fails", async () => {
  const aid = 40_003;
  await storeArenaProfile(upstreamArenaProfile(aid, 1_800_000_040_003, "Saved Arena"));
  let fetches = 0;
  const originalConsoleError = console.error;
  console.error = () => undefined;

  try {
    await withFetch(async () => {
      fetches += 1;
      return new Response("unavailable", { status: 503 });
    }, async () => {
      const response = await getProfile(profileRequest(aid, true));
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.profile, null);
      assert.equal(body.arena.nickname, "Saved Arena");
      assert.equal(body.capture.status, "refresh_failed");
      assert.equal(body.freshness.fetchedAt, body.arena.fetchedAt);
    });
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(fetches, 1);
});

test("a stale Arena refresh cannot replace the newer normalized snapshot", async () => {
  const aid = 40_004;
  const currentUpdatedAt = 1_800_000_040_004;
  await storeArenaProfile(upstreamArenaProfile(aid, currentUpdatedAt, "Current Arena"));
  let fetches = 0;

  await withFetch(async () => {
    fetches += 1;
    return Response.json(upstreamArenaProfile(aid, currentUpdatedAt - 100, "Stale Arena"));
  }, async () => {
    const response = await getProfile(profileRequest(aid, true));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.arena.nickname, "Current Arena");
    assert.equal(body.arena.profileUpdatedAt, currentUpdatedAt);
  });
  assert.equal(fetches, 1);
});

test("Arena favorite keeps its legacy snapshot offline until it is reparsed", async () => {
  const aid = 40_005;
  db.prepare(`INSERT INTO mode_players (mode, aid, nickname, fetched_at, stats_json, achievements)
    VALUES ('arena', ?, 'Favorite Legacy Arena', 789, ?, '[]')`).run(aid, JSON.stringify({
    nickname: "Favorite Legacy Arena", profileUpdatedAt: 1_800_000_040_005,
  }));
  const favorites = await getFavoritesStore();
  assert.ok(favorites);
  assert.equal(await favorites.add("favorite-arena-test", aid, "Favorite Legacy Arena", null, {
    mode: "arena", cycleId: "persistent",
  }), "ok");
  let fetches = 0;

  await withFetch(async () => {
    fetches += 1;
    throw new Error("normal Arena favorites must stay offline");
  }, async () => {
    const response = await getFavoriteStats(new NextRequest("http://local/api/favorites/stats", {
      headers: { "x-forwarded-for": "198.51.100.91" },
    }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.favorites.length, 1);
    assert.equal(body.favorites[0].arena, null);
    assert.equal(body.favorites[0].arenaStatus, "legacy_incomplete");
    assert.equal(body.favorites[0].stats.nickname, "Favorite Legacy Arena");
  });
  assert.equal(fetches, 0);
});
