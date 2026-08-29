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
const { ArenaRiskUnsupportedError, evaluateAndStoreRisk } = await import("../lib/admin/risk-service.ts");

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

test("risk backfill only rescans legacy PvE mode rows", async () => {
  const source = await readFile("scripts/backfill-admin-risk.mjs", "utf8");
  assert.match(source, /FROM mode_players p\s+WHERE p\.mode = 'pve'/);
  assert.doesNotMatch(source, /await scoreRow\(row, "arena"/);
});
