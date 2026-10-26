import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

// Match the repository's route tests. The cache shim replaces Next's request
// context only; the cohort route and its real dynamic cache are left intact.
const projectRoot = realpathSync(resolve("."));
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "next/server") return nextResolve("next/server.js", context);
  if (specifier === "next/cache") return { shortCircuit: true,
    url: pathToFileURL(resolve(projectRoot, "tests/fixtures/next-cache-shim.mjs")).href };
  if (specifier.startsWith("@/")) return { shortCircuit: true,
    url: pathToFileURL(resolve(projectRoot, `${specifier.slice(2)}.ts`)).href };
  return nextResolve(specifier, context);
} });

export const DAY_MS = 86_400_000;
export const PLAYER_METRICS = { kd_ratio: 2.5, pmc_kd_ratio: 0.8, kills_per_raid: 3,
  killed_pmc_per_raid: 0.5, pmc_survival_rate: 50, longest_win_streak: 4, level: 25 };

export function rustCohortBinary() {
  return process.env.RUST_COHORT_BIN || resolve("rust/cohort-worker/target/release",
    `tarkov-cohort-worker${process.platform === "win32" ? ".exe" : ""}`);
}

export function cohortJob({ hours = 100, raids = 100, aid = 1, dimension = "hours", mode = "regular",
  statistic = "median", period = "all", metrics = PLAYER_METRICS } = {}) {
  return { kind: "persistent", mode,
    args: [hours, raids, aid, dimension, statistic, period, metrics] };
}

export async function createCohortFixture(prefix = "rust-cohort-", mode = "regular") {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  for (const [key, name] of Object.entries({ SQLITE_PATH: "players", BANS_SQLITE_PATH: "bans",
    PROGRESSION_SQLITE_PATH: "progression", ADMIN_ANALYTICS_SQLITE_PATH: "admin",
    REPORTS_SQLITE_PATH: "reports", AVERAGE_PUBLICATION_SQLITE_PATH: "averages" })) {
    process.env[key] = join(directory, `${name}.db`);
  }
  const { getStore } = await import("../../lib/db.ts");
  assert.ok(await getStore("regular"), "the fixture needs a private SQLite database");
  const db = new DatabaseSync(process.env.SQLITE_PATH);
  const columns = ["aid", "nickname", "hours", "pmc_raids", "total_raids", "profile_updated_at",
    "last_played_at", "pvp_stats_known", "pvp_stats_version", "pmc_killed_pmc", "fetched_at",
    "kd_ratio", "pmc_kd_ratio", "kills_per_raid", "pmc_survival_rate", "longest_win_streak", "level"];
  const inserts = new Map([["regular", db.prepare(`INSERT INTO players (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)]]);
  for (const playerMode of ["pve", "arena"]) {
    inserts.set(playerMode, db.prepare(`INSERT INTO mode_players (mode,${columns.join(",")},stats_json) VALUES ('${playerMode}',${columns.map(() => "?").join(",")},?)`));
  }
  return {
    directory, db, mode,
    clear() { db.exec("DELETE FROM excluded_players; DELETE FROM players; DELETE FROM mode_players"); },
    seed(rows, now = Date.now(), rowMode = mode) {
      assert.ok(inserts.has(rowMode), "fixture mode must be regular, pve or arena");
      db.exec("BEGIN");
      try {
        for (const row of rows) {
          const complete = { nickname: "synthetic", hours: 100, pmc_raids: 100, total_raids: 100,
            profile_updated_at: now - DAY_MS, last_played_at: null, pvp_stats_known: 1,
            pvp_stats_version: 1, pmc_killed_pmc: 50, fetched_at: now,
            kd_ratio: 2.5, pmc_kd_ratio: 0.8, kills_per_raid: 3, pmc_survival_rate: 50,
            longest_win_streak: 4, level: 25, ...row };
          const values = columns.map((key) => complete[key]);
          if (rowMode !== "regular") values.push(row.stats_json ?? "{}");
          inserts.get(rowMode).run(...values);
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
}

export function* syntheticCohortRows(count) {
  for (let aid = 1; aid <= count; aid++) yield {
    aid, hours: 50 + (aid * 37) % 4950 + (aid % 10) / 10,
    pmc_raids: 20 + (aid * 13) % 1500, total_raids: 20 + (aid * 13) % 1500,
    kd_ratio: aid % 31 === 0 ? null : ((aid * 17) % 900) / 37,
    pmc_kd_ratio: aid % 29 === 0 ? null : ((aid * 19) % 200) / 53,
    kills_per_raid: ((aid * 23) % 300) / 59,
    pmc_survival_rate: aid % 11 === 0 ? 0 : ((aid * 7) % 1000) / 10,
    longest_win_streak: aid % 41, level: 1 + aid % 79,
    pmc_killed_pmc: aid % 23 === 0 ? null : (aid * 11) % 500,
    pvp_stats_version: aid % 17 === 0 ? 0 : 1,
    pvp_stats_known: aid % 19 === 0 ? 0 : 1,
  };
}

export async function seedRouteOwners(startAid, count = 4, mode = "regular") {
  const { getProgressionStore } = await import("../../lib/progression-db.ts");
  const store = await getProgressionStore(mode);
  assert.ok(store);
  const groups = { matched: [], population: [] };
  const now = Date.now() - DAY_MS;
  let aid = startAid;
  for (const [kind, hours, raids] of [["matched", 1000, 500], ["population", 1e8, 1e8]]) {
    for (let i = 0; i < count; i++, aid++) {
      const stats = { nickname: "synthetic-owner", side: "Usec", level: 25, prestige: 0,
        experience: 100000, hoursPlayed: hours, totalRaids: raids, pmcRaids: raids,
        scavRaids: 0, survivedRaids: Math.floor(raids / 2), pmcSurvived: Math.floor(raids / 2),
        deaths: Math.floor(raids / 2), pmcDeaths: Math.floor(raids / 2), totalKills: raids,
        pmcKills: raids, killedPmc: Math.floor(raids / 2), pmcKilledPmc: Math.floor(raids / 2),
        runThrough: 0, achievementsCount: 0, longestWinStreak: 4, profileUpdatedAt: now,
        kdRatio: 2.5, pmcKdRatio: 0.8, killsPerRaid: 3, pmcSurvivalRate: 50,
        pvpStatsKnown: true, pvpStatsVersion: 1 };
      const result = await store.recordSnapshot({ aid, stats, achievementIds: [], upstreamUpdatedAt: now, capturedAt: now });
      assert.ok(result.inserted);
      groups[kind].push(aid);
    }
  }
  return groups;
}

// Every field stays exact except the final floating aggregates, which SQLite's
// AVG and Rust's summation may round differently. Integer counts and selection,
// nullability, bounds, identities and percentile distributions must match exactly.
export function assertCohortParity(actual, expected, context = "cohort") {
  const normalized = structuredClone(actual);
  for (const [section, field] of [["averages", "value"], ["percentiles", "percentile"]]) {
    for (const [metric, value] of Object.entries(expected[section])) {
      const got = normalized[section]?.[metric]?.[field];
      const wanted = value[field];
      if (typeof wanted === "number") {
        assert.equal(typeof got, "number", `${context}: ${section}.${metric}.${field}`);
        assert.ok(Number.isFinite(got) && Math.abs(got - wanted) <= 1e-12 * Math.max(1, Math.abs(wanted)),
          `${context}: ${section}.${metric}.${field}: ${got} != ${wanted}`);
        normalized[section][metric][field] = wanted;
      }
    }
  }
  assert.deepEqual(normalized, expected, context);
}
