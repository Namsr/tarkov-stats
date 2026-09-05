#!/usr/bin/env node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initializeLeaderboardSchema, publishLeaderboardScope, updateLeaderboardScope } from "../lib/leaderboard/publication.ts";
import { createLeaderboardReader } from "../lib/leaderboard/service.ts";
import { materializeCandidate, referenceFormula } from "../lib/leaderboard/materialize.ts";

const rows = Number(process.argv[2] || 500_000);
if (!Number.isSafeInteger(rows) || rows < 100 || rows > 2_000_000) throw new Error("row count must be 100..2000000");
const directory = mkdtempSync(join(tmpdir(), "leaderboard-benchmark-"));
const path = join(directory, "leaderboards.db");
const db = new DatabaseSync(path);
try {
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA temp_store=FILE; CREATE TABLE excluded_players(aid INTEGER PRIMARY KEY)");
  initializeLeaderboardSchema(db);
  const config = { scope: "regular", mode: "regular", arenaMode: null, cycleId: null, primaryMetric: "performance",
    minimumSample: 6, activityCutoffMs: 100, arpSeasonId: null, arpSourceConfirmed: false };
  const sourceRows = {
    *[Symbol.iterator]() {
      for (let aid = 1; aid <= rows; aid += 1) yield { aid, nickname: `P${aid}`, sourceUpdatedAt: 1,
        parserVersion: 1, activityAt: 101, activitySource: "skill", matches: 20 + aid % 80,
        kills: 10 + aid % 500, deaths: aid % 40, hours: aid % 10_000, currentArp: null, bestArp: null };
    },
  };
  const formula = referenceFormula(sourceRows, config.activityCutoffMs);
  const durations = [];
  for (let run = 0; run < 2; run += 1) {
    const startedAt = Date.now();
    const members = {
      *[Symbol.iterator]() {
        for (const row of sourceRows) yield materializeCandidate(row, { config, formula }).member;
      },
    };
    const orders = {
      *[Symbol.iterator]() {
        for (const row of sourceRows) yield* materializeCandidate(row, { config, formula }).orders;
      },
    };
    publishLeaderboardScope(db, config.scope, { formulaVersion: 1, params: { ...config, formula }, meta: {} },
      members, orders, startedAt);
    durations.push(Date.now() - startedAt);
  }
  const current = db.prepare("SELECT generation FROM leaderboard_current WHERE scope='regular'").get();
  const incremental = [];
  for (const changedRows of [100, 1_000, 10_000]) {
    const startedAt = Date.now();
    const candidates = Array.from({ length: changedRows }, (_, index) => {
      const aid = 1 + Math.floor(index * rows / changedRows);
      const candidate = materializeCandidate({ aid, nickname: `P${aid}`, sourceUpdatedAt: changedRows,
        sourceRevision: changedRows, parserVersion: 1, activityAt: 101, activitySource: "skill",
        matches: 100, kills: rows + changedRows + aid, deaths: 1, hours: rows + aid,
        currentArp: null, bestArp: null }, { config, formula });
      return { aid, ...candidate };
    });
    const result = updateLeaderboardScope(db, config.scope, Number(current.generation),
      { formulaVersion: 1, params: { ...config, formula }, meta: {} }, candidates, startedAt);
    incremental.push({ changedRows, durationMs: Date.now() - startedAt, ...result });
  }
  const noOpStartedAt = performance.now();
  const noOpResult = updateLeaderboardScope(db, config.scope, Number(current.generation),
    { formulaVersion: 1, params: { ...config, formula }, meta: {} }, []);
  const noOp = { durationMs: Number((performance.now() - noOpStartedAt).toFixed(2)), ...noOpResult };
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const pageCount = Number(db.prepare("PRAGMA page_count").get().page_count);
  const pageSize = Number(db.prepare("PRAGMA page_size").get().page_size);
  const reader = createLeaderboardReader(db, "excluded_players");
  const readStarted = performance.now();
  const page = reader.readPage(config, "primary", Math.floor(rows / 2), 100);
  const savedReadMs = performance.now() - readStarted;
  const candidate = materializeCandidate({ aid: Math.floor(rows / 2), nickname: "Fresh", sourceUpdatedAt: 2,
    parserVersion: 1, activityAt: 101, activitySource: "skill", matches: 100, kills: rows,
    deaths: 1, hours: 100, currentArp: null, bestArp: null }, { config, formula });
  const freshStarted = performance.now();
  const fresh = reader.readPage(config, "primary", candidate.member.aid, 100, candidate);
  const freshReadMs = performance.now() - freshStarted;
  const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT ordinal FROM leaderboard_order
    WHERE scope='regular' AND generation=(SELECT generation FROM leaderboard_current WHERE scope='regular') AND sort='primary'
      AND (k1,k2,k3,k4,k5,stable_key)>(?,?,?,?,?,?)
    ORDER BY k1 ASC,k2 ASC,k3 ASC,k4 ASC,k5 ASC,stable_key ASC LIMIT 1`)
    .all(...candidate.orders.find((order) => order.sort === "primary").key)
    .map((row) => String(row.detail));
  console.log(JSON.stringify({ rows, generations: 2, ordersPerGeneration: rows * 4,
    publicationMs: durations, incremental, noOp, databaseMiB: Number((pageCount * pageSize / 1024 / 1024).toFixed(1)),
    peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
    savedReadMs: Number(savedReadMs.toFixed(2)), freshReadMs: Number(freshReadMs.toFixed(2)),
    savedAround: page?.around?.length, freshAround: fresh?.around?.length, plan }, null, 2));
} finally {
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
