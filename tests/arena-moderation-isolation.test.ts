/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- node:sqlite types are not present in the project's Node 20 type package.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
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

const { createSqliteModerationStore } = await import("../lib/admin/moderation-db.ts");
const { ArenaRiskUnsupportedError, evaluateAndStoreRisk, riskScoreVersion } = await import("../lib/admin/risk-service.ts");
const { hasValidRiskInputs } = await import("../lib/cheater-score.ts");

const risk = (aid, mode, score, profileUpdatedAt = 10) => ({
  aid,
  mode,
  cycleId: "persistent",
  score,
  tier: score >= 80 ? "severe" : score >= 40 ? "high" : score >= 20 ? "medium" : "low",
  factors: [],
  scoreVersion: 1,
  profileUpdatedAt,
  evaluatedAt: 20,
});

function moderationDb() {
  const db = new DatabaseSync(":memory:");
  for (const schema of ["bans_db", "players_db", "progression_db", "reports_db"]) {
    db.exec(`ATTACH DATABASE ':memory:' AS ${schema}`);
  }
  return db;
}

test("legacy moderation ignores Arena risk rows", () => {
  const db = moderationDb();
  try {
    const store = createSqliteModerationStore(db, { attachExternal: false });
    store.saveRisk(risk(101, "arena", 100));

    assert.deepEqual(store.automaticSuspiciousAids(), []);
    assert.deepEqual(store.suspiciousAids(), []);
    const row = store.forAids([101])[0];
    assert.equal(row.risk, null);
    assert.equal(row.sources.automaticRisk, false);
  } finally {
    db.close();
  }
});

test("an Arena row cannot override a legacy mode risk", () => {
  const db = moderationDb();
  try {
    const store = createSqliteModerationStore(db, { attachExternal: false });
    store.saveRisk(risk(102, "regular", 25));
    store.saveRisk(risk(102, "arena", 100));

    const row = store.forAids([102])[0];
    assert.equal(row.risk?.mode, "regular");
    assert.equal(row.risk?.score, 25);
    assert.equal(row.sources.automaticRisk, true);
    assert.deepEqual(store.automaticSuspiciousAids(), [102]);
  } finally {
    db.close();
  }
});

test("generic risk evaluation rejects Arena before touching a store", async () => {
  const playerStore = {
    baseline() { throw new Error("baseline should not run"); },
    achievementBaseline() { throw new Error("achievement baseline should not run"); },
  };
  await assert.rejects(
    evaluateAndStoreRisk({
      aid: 103,
      mode: "arena",
      stats: { hoursPlayed: 100 },
      achievementIds: [],
      playerStore,
    }),
    (error) => error instanceof ArenaRiskUnsupportedError && error.message === "Arena risk is display-only",
  );
});

test("risk versions are isolated from untouched modes and cycles", () => {
  assert.equal(riskScoreVersion("regular", "persistent"), 2);
  assert.equal(riskScoreVersion("pve", "persistent"), 1);
  assert.equal(riskScoreVersion("seasonal", "cycle-a"), 1);
  assert.throws(() => riskScoreVersion("seasonal"), /cycleId/);
});

test("backfill guard executes the shared invalid-input predicate", () => {
  const valid = {
    pvpStatsKnown: true,
    hoursPlayed: 100,
    pmcRaids: 5,
    prestige: 0,
    pmcSurvivalRate: 50,
    pmcKdRatio: 8,
    pmcKillsPerRaid: 1,
    longestWinStreak: 0,
  };
  assert.equal(hasValidRiskInputs(valid), true);
  assert.equal(hasValidRiskInputs({ ...valid, longestWinStreak: Number.NaN }), false);
  assert.equal(hasValidRiskInputs({ ...valid, prestige: undefined }), false);
});

test("risk backfill only rescans legacy PvE mode rows", async () => {
  const source = await readFile("scripts/backfill-admin-risk.mjs", "utf8");
  const service = await readFile("lib/admin/risk-service.ts", "utf8");
  assert.match(service, /input\.mode === "regular"[\s\S]*store\.riskBaseline/);
  assert.match(service, /store\.baseline\(bracket\.lo, bracket\.hi\)/);
  assert.match(source, /FROM mode_players p\s+WHERE p\.mode = 'pve'/);
  assert.match(source, /scoreVersion: riskScoreVersion\(mode, cycleId\)/);
  assert.match(source, /function optionalNumber\(value\)/);
  assert.match(source, /statsFromRow\(row, mode\)/);
  assert.match(source, /mode === "regular" \|\| mode === "pve"/);
  assert.match(source, /regularRiskBaselineFor\(stats, Number\(row\.aid\)\)/);
  assert.match(source, /const hasUsableMetrics = baseline != null/);
  assert.match(source, /hasUsableMetrics && hasValidRiskInputs\(stats\)/);
  assert.match(source, /scoreCheater\(\{ \.\.\.stats, pmcRaids: 0 \}, null, null\)/);
  assert.doesNotMatch(source, /await scoreRow\(row, "arena"/);
});
