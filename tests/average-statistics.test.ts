/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript runner requires explicit .ts imports.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import test from "node:test";
// @ts-ignore -- Node 24 exposes node:sqlite at runtime; project types target Node 20.
import { DatabaseSync } from "node:sqlite";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier.startsWith("@/")) {
      return {
        shortCircuit: true,
        url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href,
      };
    }
    return nextResolve(specifier, context);
  },
});

const directory = mkdtempSync(join(tmpdir(), "tarkov-average-"));
const databasePath = join(directory, "players.db");
process.env.SQLITE_PATH = databasePath;
process.env.BANS_SQLITE_PATH = join(directory, "bans.db");
process.env.PROGRESSION_SQLITE_PATH = join(directory, "progression.db");

const { getStore } = await import("../lib/db.ts");
const { GET: getAverage } = await import("../app/api/average/route.ts");
const { GET: getCohort } = await import("../app/api/average/cohort/route.ts");
const { NextRequest } = await import("next/server");
const store = await getStore();
assert.ok(store);
const db = new DatabaseSync(databasePath);
const insert = db.prepare(`INSERT INTO players
  (aid, nickname, hours, pmc_raids, total_raids, kd_ratio, pmc_kd_ratio,
   kills_per_raid, pmc_survival_rate, longest_win_streak, level, fetched_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);

function reset() {
  db.exec("DELETE FROM players");
}

function add(aid, options = {}) {
  const value = options.value ?? aid;
  insert.run(
    aid,
    `p${aid}`,
    options.hours ?? 100,
    options.raids ?? 100,
    options.totalRaids === undefined ? value : options.totalRaids,
    value,
    value,
    value,
    options.survival ?? value,
    value,
    value,
  );
}

const range = (min, max, excludeAid) => ({
  dimension: "hours",
  min,
  max,
  maxInclusive: true,
  ...(excludeAid == null ? {} : { excludeAid }),
});

test("SQLite median handles empty, odd, even, repeated, missing, and singleton values", async () => {
  reset();
  assert.deepEqual(await store.averages(range(0, 999), "median"), {
    n: 0,
    hours: null,
    total_raids: null,
    pmc_raids: null,
    scav_raids: null,
    survival_rate: null,
    kd_ratio: null,
    pmc_kd_ratio: null,
    kills_per_raid: null,
    total_kills: null,
    deaths: null,
    killed_pmc: null,
    run_through: null,
    longest_win_streak: null,
    achv_count: null,
    level: null,
    prestige: null,
    pmc_survival_rate: null,
  });

  add(1, { hours: 10, totalRaids: 1 });
  assert.equal((await store.averages(range(10, 10), "median")).total_raids, 1);

  reset();
  add(1, { hours: 20, totalRaids: 1 });
  add(2, { hours: 20, totalRaids: 2 });
  add(3, { hours: 20, totalRaids: 100 });
  assert.equal((await store.averages(range(20, 20), "median")).total_raids, 2);
  add(4, { hours: 20, totalRaids: 200 });
  assert.equal((await store.averages(range(20, 20), "median")).total_raids, 51);

  reset();
  add(1, { hours: 30, totalRaids: 5 });
  add(2, { hours: 30, totalRaids: 5 });
  add(3, { hours: 30, totalRaids: null });
  add(4, { hours: 30, totalRaids: 9 });
  assert.equal((await store.averages(range(30, 30), "median")).total_raids, 5);
});

test("trimmed mean keeps the 19/20 boundary and range/exclusion filters", async () => {
  reset();
  for (let aid = 1; aid <= 18; aid++) add(aid, { hours: 40, totalRaids: aid });
  add(19, { hours: 40, totalRaids: 1000 });
  assert.equal((await store.averages(range(40, 40))).total_raids, 1171 / 19);

  reset();
  for (let aid = 1; aid <= 19; aid++) add(aid, { hours: 50, totalRaids: aid });
  add(20, { hours: 50, totalRaids: 1000 });
  assert.equal((await store.averages(range(50, 50), "trimmed_mean")).total_raids, 10.5);

  reset();
  add(1, { hours: 60, totalRaids: 1 });
  add(2, { hours: 60, totalRaids: 10 });
  add(3, { hours: 60, totalRaids: 100 });
  add(4, { hours: 70, totalRaids: 1000 });
  const filtered = await store.averages(range(60, 60, 2), "median");
  assert.equal(filtered.n, 2);
  assert.equal(filtered.total_raids, 50.5);
});

test("cohort median preserves target/expansion, excludes the open aid, and filters PMC survival", async () => {
  reset();
  add(999, { hours: 100, value: 10000, survival: 10000 });
  for (let aid = 1; aid <= 20; aid++) {
    add(aid, {
      hours: aid <= 9 ? 89 : 100,
      value: aid,
      survival: aid === 10 ? 40 : aid === 11 ? 60 : 0,
    });
  }
  const cohort = await store.cohort("hours", 100, 999, "median");
  assert.equal(cohort.quality, "sufficient");
  assert.equal(cohort.percent, 15);
  assert.equal(cohort.n, 20);
  assert.equal(cohort.averages.kd_ratio.value, 10.5);
  assert.deepEqual(cohort.averages.pmc_survival_rate, { value: 50, count: 2 });
});

test("average and cohort API contracts default, echo median, and reject unknown statistics", async () => {
  reset();
  add(1, { hours: 100, totalRaids: 1 });
  add(2, { hours: 100, totalRaids: 2 });
  add(3, { hours: 100, totalRaids: 100 });

  const defaultResponse = await getAverage(new NextRequest("http://local/api/average"));
  assert.equal(defaultResponse.status, 200);
  assert.equal((await defaultResponse.json()).statistic, "trimmed_mean");

  const medianResponse = await getAverage(new NextRequest("http://local/api/average?statistic=median"));
  const medianBody = await medianResponse.json();
  assert.equal(medianBody.statistic, "median");
  assert.equal(medianBody.averages.total_raids, 2);

  assert.equal((await getAverage(new NextRequest(
    "http://local/api/average?statistic=mean",
  ))).status, 400);

  reset();
  const emptyAverage = await getAverage(new NextRequest(
    "http://local/api/average?statistic=median",
  ));
  assert.equal((await emptyAverage.json()).statistic, "median");

  const defaultCohort = await getCohort(new NextRequest(
    "http://local/api/average/cohort?center=0&excludeAid=1",
  ));
  assert.equal((await defaultCohort.json()).statistic, "trimmed_mean");

  const unavailable = await getCohort(new NextRequest(
    "http://local/api/average/cohort?center=0&excludeAid=1&statistic=median",
  ));
  assert.equal(unavailable.status, 200);
  assert.equal((await unavailable.json()).statistic, "median");
  assert.equal((await getCohort(new NextRequest(
    "http://local/api/average/cohort?center=1&excludeAid=1&statistic=mean",
  ))).status, 400);
});
