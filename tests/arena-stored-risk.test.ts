/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript runner needs explicit source hooks.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
    }
    return nextResolve(specifier, context);
  },
});

const directory = mkdtempSync(join(tmpdir(), "tarkov-arena-stored-risk-"));
process.env.SQLITE_PATH = join(directory, "players.db");
process.env.BANS_SQLITE_PATH = join(directory, "bans.db");

const { getStore } = await import("../lib/db.ts");
const { parseArenaProfileStats } = await import("../lib/tarkov-api.ts");
const {
  getArenaProfile,
  getArenaProfileRisk,
  getStoredArenaProfileRisk,
  isArenaProfileRiskFresh,
} = await import("../lib/arena/service.ts");

assert.ok(await getStore("arena"));

const modeNames = [
  "UnrankedTeamFight",
  "UnrankedLastHero",
  "UnrankedCheckPoint",
  "UnrankedBlastGang",
  "UnrankedShootOutDuo",
];

function group(games, kills, deaths) {
  return {
    Counters: {
      GamesCount: games,
      ArenaWins: Math.floor(games / 2),
      ArenaLoses: Math.floor(games / 3),
      Kills: kills,
      Deaths: deaths,
      Assists: 2,
      Headshots: Math.floor(kills / 4),
      DamageDealt: kills * 400,
      RoundMvpCount: 2,
      MatchMvpCount: 1,
      KillsWithoutDeaths: 2,
      MaxKillsWithoutDeaths: 7,
      WinStreak: 2,
      LongestWinStreak: 5,
      LoseStreak: 1,
      LongestLoseStreak: 3,
    },
  };
}

function profile(aid, { updated = 1_800_000_000_000 + aid, kills = 22, deaths = 20 } = {}) {
  return {
    aid,
    updated,
    info: { nickname: `Arena${aid}`, side: "Usec", experience: 0 },
    stat: {
      totalInGameTime: 360_000,
      arenaOverAllCounters: {
        UnrankedOverall: group(100, kills * 5 + 10, deaths * 5),
        ...Object.fromEntries(modeNames.map((name, index) => [name, group(20, kills + index, deaths)])),
      },
    },
  };
}

async function save(source) {
  const store = await getStore("arena");
  assert.ok(store);
  await store.upsert(source.aid, parseArenaProfileStats(source), []);
}

function readRiskRow(aid) {
  const db = new DatabaseSync(process.env.SQLITE_PATH);
  try {
    return db.prepare("SELECT aid, upstream_version, parser_version, evaluated_at, risk_json FROM arena_risk_evaluations WHERE aid = ?").get(aid);
  } finally {
    db.close();
  }
}

async function backdateStoredRisk(aid, ageMs) {
  const row = readRiskRow(aid);
  assert.ok(row, "stored risk row must exist");
  const parsed = JSON.parse(String(row.risk_json));
  const backdated = Date.now() - ageMs;
  parsed.freshness = { ...parsed.freshness, evaluatedAt: backdated };
  const db = new DatabaseSync(process.env.SQLITE_PATH);
  try {
    db.prepare("UPDATE arena_risk_evaluations SET evaluated_at = ?, risk_json = ? WHERE aid = ?").run(
      backdated,
      JSON.stringify(parsed),
      aid,
    );
  } finally {
    db.close();
  }
  return backdated;
}

test("stored Arena risk is reused without recomputation when fresh", async () => {
  const aid = 50_001;
  await save(profile(aid));
  const computed = await getArenaProfileRisk(aid);
  assert.ok(computed, "initial risk computation must succeed");
  // 1s old stays fresh under the 5h TTL but is far enough to detect a rewrite.
  const backdated = await backdateStoredRisk(aid, 1_000);
  const before = readRiskRow(aid);
  assert.equal(Number(before.evaluated_at), backdated);

  const stored = await getStoredArenaProfileRisk(aid);
  assert.ok(stored, "stored risk row must be readable with a single-row lookup");
  assert.equal(stored.score, computed.score);
  assert.equal(stored.version.calculation, computed.version.calculation);
  assert.equal(isArenaProfileRiskFresh(stored, 1_800_000_000_000 + aid), true);

  // Freshness gates: version drift, profile drift and TTL expiry all force refresh.
  assert.equal(isArenaProfileRiskFresh(null, 1_800_000_000_000 + aid), false);
  assert.equal(
    isArenaProfileRiskFresh({ ...stored, version: { ...stored.version, calculation: -1 } }, 1_800_000_000_000 + aid),
    false,
  );
  assert.equal(isArenaProfileRiskFresh(stored, 1_800_000_000_000 + aid + 1_000_000), false);

  const missing = await getStoredArenaProfileRisk(9_999_999);
  assert.equal(missing, null);

  const after = readRiskRow(aid);
  assert.equal(Number(after.evaluated_at), backdated, "reading stored risk must not rewrite the row");
  assert.equal(String(after.risk_json), String(before.risk_json));
});

test("slow risk recomputation does not delay the stored profile response", async () => {
  const aid = 50_002;
  await save(profile(aid));
  const computed = await getArenaProfileRisk(aid);
  assert.ok(computed);
  await backdateStoredRisk(aid, 1_000);

  // Delayed-endpoint pattern like tests/mode-switch-cancel.test.ts: a full
  // cohort recomputation takes ~80ms while the stored read stays instant.
  // The stored profile path must await only the fast lookup, never the slow one.
  let slowSettled = false;
  const slowRecalculation = new Promise((resolve) => {
    setTimeout(() => {
      slowSettled = true;
      resolve("recalculated");
    }, 80);
  });

  const startedAt = Date.now();
  const [storedProfile, storedRisk] = await Promise.all([
    getArenaProfile(aid),
    getStoredArenaProfileRisk(aid),
  ]);
  const elapsed = Date.now() - startedAt;

  assert.ok(storedProfile, "stored profile must be readable");
  assert.ok(storedRisk, "stored risk must be readable");
  assert.equal(slowSettled, false, "stored response must return before the slow recomputation finishes");
  // If the stored path awaited the full recomputation, we would wait ~80ms.
  assert.ok(elapsed < 70, `stored hit must not wait for slow risk, took ${elapsed}ms`);
  assert.equal(storedRisk.score, computed.score);

  await slowRecalculation;
  assert.equal(slowSettled, true);
});

test("arena route separates profile and risk timing phases and refreshes stale risk in background", async () => {
  const route = await readFile("app/api/player/profile/route.ts", "utf8");
  const service = await readFile("lib/arena/service.ts", "utf8");
  const timing = await readFile("lib/observability/request-timing.ts", "utf8");
  const analytics = await readFile("lib/admin/analytics-db.ts", "utf8");

  assert.match(service, /export async function getStoredArenaProfileRisk/);
  assert.match(service, /export function isArenaProfileRiskFresh/);
  assert.match(service, /ARENA_RISK_TTL_MS/);
  assert.match(service, /SELECT risk_json FROM arena_risk_evaluations WHERE aid = \?/);

  const arenaFunction = route.slice(route.indexOf("async function arenaProfileResponse"));
  assert.match(arenaFunction, /getStoredArenaProfileRisk/);
  assert.match(arenaFunction, /isArenaProfileRiskFresh/);
  assert.match(arenaFunction, /scheduleArenaRiskRefresh/);
  assert.match(arenaFunction, /after\(async \(\) => \{[\s\S]*setTimeout\(resolve, 1_000\)[\s\S]*getArenaProfileRisk/);
  assert.match(arenaFunction, /const isStoredHit = !force && source === "stored"/);

  const storedBranch = arenaFunction.slice(arenaFunction.indexOf("const isStoredHit"));
  assert.match(storedBranch, /await getStoredArenaProfileRisk/);
  assert.doesNotMatch(storedBranch.slice(0, storedBranch.indexOf("} else {")), /await getArenaProfileRisk/);

  assert.match(arenaFunction, /storeReadMs/);
  assert.match(arenaFunction, /riskMs/);
  assert.match(arenaFunction, /storeReadStarted/);
  assert.match(arenaFunction, /riskStarted/);
  assert.match(route, /storage: "sqlite", profileMs, storeReadMs, riskMs/);

  assert.match(timing, /riskMs\?: number/);
  assert.match(timing, /riskMs: input\.riskMs/);
  assert.match(timing, /risk_ms: roundedMs\(input\.riskMs\)/);

  assert.match(analytics, /riskMs\?: number \| null/);
  assert.match(analytics, /\["risk", "risk_ms"\]/);
  assert.match(analytics, /risk_ms INTEGER/);
});
