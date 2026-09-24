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
const { ARENA_PARSER_VERSION } = await import("../lib/arena/storage.ts");
const { GET: getAverage } = await import("../app/api/average/route.ts");
const { GET: getCohort } = await import("../app/api/average/cohort/route.ts");
const { GET: getBaselinesBatch } = await import("../app/api/average/cohort/batch/route.ts");
const { GET: getProfile } = await import("../app/api/player/profile/route.ts");
const { GET: getFavoriteStats } = await import("../app/api/favorites/stats/route.ts");
const { ARENA_METRIC_KEYS, toArenaPopulationCohort } = await import("../components/arena-ui.ts");
const { NextRequest } = await import("next/server");

assert.ok(await getStore("arena"));
const db = new DatabaseSync(process.env.SQLITE_PATH);
const modes = ["overall", "teamFight", "lastHero", "checkpoint", "blastGang", "shootOutDuo"];
const insert = db.prepare(`INSERT INTO arena_mode_stats (
  aid, arena_mode, hours, games_count, kd_ratio, win_rate, headshot_rate,
  kills_per_match, damage_per_match, upstream_version, parser_version, raw_json, fetched_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, '{}', 1)`);

for (let aid = 1; aid <= 22; aid += 1) {
  for (const mode of modes) {
    const sparseLastHero = mode === "lastHero" && aid > 1 && aid <= 17;
    insert.run(
      aid,
      mode,
      sparseLastHero ? 1_000 : 100,
      sparseLastHero ? 1_000 : 100,
      aid,
      50,
      25,
      2,
      500,
      ARENA_PARSER_VERSION,
    );
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
  assert.equal(body.schemaVersion, ARENA_PARSER_VERSION);
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

test("publication-only Arena fallback never falls back to dynamic averages", async () => {
  const publications = await import("../lib/average-publication.ts");
  const previousEnabled = process.env.AVERAGE_PUBLICATIONS_ENABLED;
  process.env.AVERAGE_PUBLICATIONS_ENABLED = "false";
  publications.resetAveragePublicationForTests();
  try {
    const response = await getAverage(new NextRequest(
      "http://local/api/average?mode=arena&arenaMode=lastHero&statistic=trimmed_mean&publicationOnly=1",
    ));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "Arena average publication unavailable");
  } finally {
    publications.resetAveragePublicationForTests();
    if (previousEnabled === undefined) delete process.env.AVERAGE_PUBLICATIONS_ENABLED;
    else process.env.AVERAGE_PUBLICATIONS_ENABLED = previousEnabled;
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
  assert.equal(body.schemaVersion, ARENA_PARSER_VERSION);
  assert.deepEqual(body.target, { hours: 100, matches: 100 });
  assert.equal(body.quality, "sufficient");
  assert.equal(body.sampleN, 21);

  const sparseResponse = await getCohort(new NextRequest(
    "http://local/api/average/cohort?mode=arena&aid=1&arenaMode=lastHero&statistic=trimmed_mean",
  ));
  assert.equal(sparseResponse.status, 200);
  const sparse = await sparseResponse.json();
  assert.equal(sparse.mode, "lastHero");
  assert.equal(sparse.strategy, "matched");
  assert.equal(sparse.quality, "unavailable");
  assert.equal(sparse.sampleN, 5);
  assert.deepEqual(sparse.bounds, {
    hours: { min: 70, max: 130 },
    matches: { min: 70, max: 130 },
  });

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
test("Arena population fallback validates the real average payload before trusting it", async () => {
  const cohortResponse = await getCohort(new NextRequest(
    "http://local/api/average/cohort?mode=arena&aid=1&arenaMode=lastHero&statistic=trimmed_mean",
  ));
  assert.equal(cohortResponse.status, 200);
  const cohort = await cohortResponse.json();
  assert.equal(cohort.strategy, "matched");
  assert.equal(cohort.quality, "unavailable");
  assert.equal(cohort.sampleN, 5);

  const averageResponse = await getAverage(new NextRequest(
    "http://local/api/average?mode=arena&arenaMode=lastHero&statistic=trimmed_mean",
  ));
  assert.equal(averageResponse.status, 200);
  const average = await averageResponse.json();
  assert.equal(average.mode, "arena");
  assert.deepEqual(average.filterIdentity, {
    mode: "lastHero", statistic: "trimmed_mean", dimension: "matches", metric: "players",
    minHours: null, maxHours: null, minMatches: null, maxMatches: null,
  });

  const fallback = toArenaPopulationCohort(average, 1, "lastHero", "trimmed_mean", cohort.schemaVersion);
  assert.ok(fallback);
  assert.equal(fallback.strategy, "population");
  assert.equal(fallback.mode, "lastHero");
  assert.equal(fallback.sampleN, 22);
  assert.equal(fallback.quality, "sufficient");
  assert.equal(fallback.reason, null);
  assert.equal(fallback.required, 20);
  assert.deepEqual(fallback.bounds.matches, { min: 10, max: null });
  for (const metric of ARENA_METRIC_KEYS) {
    assert.ok(fallback.metrics[metric].count >= 20, `${metric} needs a usable population sample`);
    assert.ok(fallback.metrics[metric].value !== null, `${metric} needs a population mean`);
  }

  // A narrowed identity describes a different slice and must never pass as the population cohort.
  assert.equal(toArenaPopulationCohort(
    { ...average, filterIdentity: { ...average.filterIdentity, minMatches: 10 } },
    1, "lastHero", "trimmed_mean", cohort.schemaVersion,
  ), null);
});

test("Arena population fallback also trusts the published average payload", async () => {
  const publications = await import("../lib/average-publication.ts");
  const previousEnabled = process.env.AVERAGE_PUBLICATIONS_ENABLED;
  const previousPath = process.env.AVERAGE_PUBLICATION_SQLITE_PATH;
  process.env.AVERAGE_PUBLICATIONS_ENABLED = "true";
  process.env.AVERAGE_PUBLICATION_SQLITE_PATH = join(directory, "average-publications-fallback.db");
  publications.resetAveragePublicationForTests();
  try {
    const payload = await getArenaAverage({
      mode: "lastHero", statistic: "trimmed_mean", dimension: "matches", metric: "players",
    });
    assert.ok(payload);
    await publications.publishAverageScope("arena", new Map([[
      publications.standardArenaVariant("lastHero", "trimmed_mean"), payload,
    ]]), Date.now() - 10, Date.now());
    const response = await getAverage(new NextRequest(
      "http://local/api/average?mode=arena&arenaMode=lastHero&statistic=trimmed_mean&publicationOnly=1",
    ));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-average-source"), "publication");
    const body = await response.json();
    const cohortResponse = await getCohort(new NextRequest(
      "http://local/api/average/cohort?mode=arena&aid=1&arenaMode=lastHero&statistic=trimmed_mean",
    ));
    assert.equal(cohortResponse.status, 200);
    const cohort = await cohortResponse.json();
    const fallback = toArenaPopulationCohort(body, 1, "lastHero", "trimmed_mean", cohort.schemaVersion);
    assert.ok(fallback);
    assert.equal(fallback.strategy, "population");
    assert.equal(fallback.sampleN, 22);
    assert.equal(fallback.quality, "sufficient");
  } finally {
    publications.resetAveragePublicationForTests();
    if (previousEnabled === undefined) delete process.env.AVERAGE_PUBLICATIONS_ENABLED;
    else process.env.AVERAGE_PUBLICATIONS_ENABLED = previousEnabled;
    if (previousPath === undefined) delete process.env.AVERAGE_PUBLICATION_SQLITE_PATH;
    else process.env.AVERAGE_PUBLICATION_SQLITE_PATH = previousPath;
  }
});

test("Arena mode baselines batch all five modes in one request", async () => {
  const response = await getBaselinesBatch(new NextRequest(
    "http://local/api/average/cohort/batch?mode=arena&aid=1&statistic=trimmed_mean&purpose=comparison",
  ));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, max-age=60");
  const body = await response.json();
  assert.equal(body.gameMode, "arena");
  assert.equal(body.schemaVersion, ARENA_PARSER_VERSION);
  assert.equal(body.aid, 1);
  assert.equal(body.purpose, "comparison");
  assert.deepEqual(Object.keys(body.cohorts).sort(), ["blastGang", "checkpoint", "lastHero", "shootOutDuo", "teamFight"]);
  assert.deepEqual(body.unavailable, []);

  const team = body.cohorts.teamFight;
  assert.equal(team.strategy, "matched");
  assert.equal(team.quality, "sufficient");
  assert.ok(team.averageMatches.value > 0);
  assert.ok(team.averageMatches.count >= 20);

  // The sparse lastHero fixture (5 peers) resolves to the same-mode
  // population inline: no second HTTP round-trip needed.
  const lastHero = body.cohorts.lastHero;
  assert.equal(lastHero.mode, "lastHero");
  assert.equal(lastHero.strategy, "population");
  assert.equal(lastHero.quality, "sufficient");
  assert.ok(lastHero.averageMatches.value > 0);
  assert.ok(lastHero.averageMatches.count >= 20);
});

test("Arena mode baselines use matched cohorts before population fallback for matches", async () => {
  const response = await getBaselinesBatch(new NextRequest(
    "http://local/api/average/cohort/batch?mode=arena&aid=1&statistic=median&purpose=matches",
  ));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.purpose, "matches");
  assert.deepEqual(body.unavailable, []);
  for (const mode of ["teamFight", "lastHero", "checkpoint", "blastGang", "shootOutDuo"]) {
    const cohort = body.cohorts[mode];
    assert.equal(cohort.mode, mode);
    assert.equal(cohort.strategy, mode === "lastHero" ? "population" : "matched");
    assert.equal(cohort.quality, "sufficient");
    assert.ok(cohort.averageMatches.value > 0, `${mode} needs a matches baseline`);
    assert.ok(cohort.averageMatches.count >= 20, `${mode} needs a usable matches sample`);
  }
});

test("Arena mode baselines compute matches without publications", async () => {
  const publications = await import("../lib/average-publication.ts");
  const previousEnabled = process.env.AVERAGE_PUBLICATIONS_ENABLED;
  process.env.AVERAGE_PUBLICATIONS_ENABLED = "false";
  publications.resetAveragePublicationForTests();
  try {
    // publicationOnly=1 answers 503 here; the batch falls back to live
    // averages so markers keep working while publications are warming.
    const response = await getBaselinesBatch(new NextRequest(
      "http://local/api/average/cohort/batch?mode=arena&aid=1&statistic=trimmed_mean&purpose=matches",
    ));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.cohorts.teamFight.averageMatches.value > 0);
  } finally {
    publications.resetAveragePublicationForTests();
    if (previousEnabled === undefined) delete process.env.AVERAGE_PUBLICATIONS_ENABLED;
    else process.env.AVERAGE_PUBLICATIONS_ENABLED = previousEnabled;
  }
});

test("Arena mode baselines ignore stale publications without averageMatches", async () => {
  const publications = await import("../lib/average-publication.ts");
  const previousEnabled = process.env.AVERAGE_PUBLICATIONS_ENABLED;
  const previousPath = process.env.AVERAGE_PUBLICATION_SQLITE_PATH;
  process.env.AVERAGE_PUBLICATIONS_ENABLED = "true";
  process.env.AVERAGE_PUBLICATION_SQLITE_PATH = join(directory, "average-publications-legacy.db");
  publications.resetAveragePublicationForTests();
  try {
    const payload = await getArenaAverage({
      mode: "lastHero", statistic: "trimmed_mean", dimension: "matches", metric: "players",
    });
    assert.ok(payload?.averageMatches.value);
    // Simulate a publication materialized before PR83: valid shape, no matches baseline.
    const legacyPayload: Record<string, unknown> = { ...payload };
    delete legacyPayload.averageMatches;
    await publications.publishAverageScope("arena", new Map([[
      publications.standardArenaVariant("lastHero", "trimmed_mean"), legacyPayload,
    ]]), Date.now() - 10, Date.now());

    // The matches tab must still get its baseline via live computation.
    const matches = await getBaselinesBatch(new NextRequest(
      "http://local/api/average/cohort/batch?mode=arena&aid=1&statistic=trimmed_mean&purpose=matches&arenaModes=lastHero",
    ));
    assert.equal(matches.status, 200);
    const matchesBody = await matches.json();
    assert.deepEqual(matchesBody.unavailable, []);
    assert.ok(matchesBody.cohorts.lastHero.averageMatches.value > 0);

    // The kd/winrate comparison does not need the matches baseline and may
    // keep serving the stale-but-valid publication payload.
    const comparison = await getBaselinesBatch(new NextRequest(
      "http://local/api/average/cohort/batch?mode=arena&aid=1&statistic=trimmed_mean&purpose=comparison&arenaModes=lastHero",
    ));
    assert.equal(comparison.status, 200);
    assert.equal((await comparison.json()).cohorts.lastHero.strategy, "population");
  } finally {
    publications.resetAveragePublicationForTests();
    if (previousEnabled === undefined) delete process.env.AVERAGE_PUBLICATIONS_ENABLED;
    else process.env.AVERAGE_PUBLICATIONS_ENABLED = previousEnabled;
    if (previousPath === undefined) delete process.env.AVERAGE_PUBLICATION_SQLITE_PATH;
    else process.env.AVERAGE_PUBLICATION_SQLITE_PATH = previousPath;
  }
});

test("Arena mode baselines ignore insufficient published populations for matches", async () => {
  const publications = await import("../lib/average-publication.ts");
  const previousEnabled = process.env.AVERAGE_PUBLICATIONS_ENABLED;
  const previousPath = process.env.AVERAGE_PUBLICATION_SQLITE_PATH;
  process.env.AVERAGE_PUBLICATIONS_ENABLED = "true";
  process.env.AVERAGE_PUBLICATION_SQLITE_PATH = join(directory, "average-publications-insufficient.db");
  publications.resetAveragePublicationForTests();
  try {
    const payload = await getArenaAverage({
      mode: "lastHero", statistic: "trimmed_mean", dimension: "matches", metric: "players",
    });
    assert.ok(payload);
    await publications.publishAverageScope("arena", new Map([[
      publications.standardArenaVariant("lastHero", "trimmed_mean"), {
        ...payload,
        sampleN: 1,
        averageMatches: { value: 1000, count: 1, reason: "insufficient_values" },
      },
    ]]), Date.now() - 10, Date.now());

    const response = await getBaselinesBatch(new NextRequest(
      "http://local/api/average/cohort/batch?mode=arena&aid=1&statistic=trimmed_mean&purpose=matches&arenaModes=lastHero",
    ));
    assert.equal(response.status, 200);
    const cohort = (await response.json()).cohorts.lastHero;
    assert.equal(cohort.strategy, "population");
    assert.equal(cohort.quality, "sufficient");
    assert.ok(cohort.sampleN >= 20);
    assert.ok(cohort.averageMatches.count >= 20);
  } finally {
    publications.resetAveragePublicationForTests();
    if (previousEnabled === undefined) delete process.env.AVERAGE_PUBLICATIONS_ENABLED;
    else process.env.AVERAGE_PUBLICATIONS_ENABLED = previousEnabled;
    if (previousPath === undefined) delete process.env.AVERAGE_PUBLICATION_SQLITE_PATH;
    else process.env.AVERAGE_PUBLICATION_SQLITE_PATH = previousPath;
  }
});

test("Arena mode baselines validate the batch contract", async () => {
  for (const query of [
    "mode=arena&statistic=trimmed_mean",
    "mode=arena&aid=0&statistic=trimmed_mean",
    "mode=arena&aid=1&statistic=mean",
    "mode=arena&aid=1&statistic=trimmed_mean&purpose=peak",
    "mode=arena&aid=1&statistic=trimmed_mean&arenaModes=teamFight,unknown",
    "mode=arena&aid=1&statistic=trimmed_mean&arenaModes=",
    "mode=arena&aid=1&statistic=trimmed_mean&arenaModes=teamFight,teamFight",
    "mode=regular&aid=1&statistic=trimmed_mean",
  ]) {
    assert.equal((await getBaselinesBatch(new NextRequest(
      `http://local/api/average/cohort/batch?${query}`,
    ))).status, 400, query);
  }

  const subset = await getBaselinesBatch(new NextRequest(
    "http://local/api/average/cohort/batch?mode=arena&aid=1&statistic=trimmed_mean&arenaModes=teamFight,lastHero",
  ));
  assert.equal(subset.status, 200);
  assert.deepEqual(Object.keys((await subset.json()).cohorts).sort(), ["lastHero", "teamFight"]);

  const defaulted = await getBaselinesBatch(new NextRequest(
    "http://local/api/average/cohort/batch?mode=arena&aid=1&statistic=trimmed_mean",
  ));
  assert.equal(defaulted.status, 200);
  assert.equal((await defaulted.json()).purpose, "comparison");
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
    assert.equal(body.tsRating.version, "0.1");
    assert.equal(body.tsRating.referenceVersion, "arena-median-2026-09-16");
    assert.ok(body.tsRating.modes.teamFight.rating > 0);
    // The fixture's overall match count differs from the sum of its modes.
    assert.equal(body.tsRating.overall.rating, null);
    assert.equal(body.tsRating.overall.reason, "incomplete_coverage");
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
      assert.ok(body.tsRating.modes.teamFight.rating > 0);
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
