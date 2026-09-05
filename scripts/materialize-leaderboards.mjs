#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import process from "node:process";
import { leaderboardConfigChanged, leaderboardFullReason, leaderboardScopeConfigs } from "../lib/leaderboard/config.ts";
import { initializeProfileChangeJournal } from "../lib/profile-change-journal.ts";
import { initializeSeasonalSchema } from "../lib/seasonal/storage.ts";
import {
  LEADERBOARD_FORMULA_VERSION,
  LEADERBOARD_METRIC_VERSION,
  materializeCandidate,
  referenceFormula,
} from "../lib/leaderboard/materialize.ts";
import {
  beginLeaderboardPublication,
  failLeaderboardPublication,
  initializeLeaderboardSchema,
  leaderboardPublicationPath,
  leaderboardSourceCursor,
  publishLeaderboardScope,
  updateLeaderboardScope,
} from "../lib/leaderboard/publication.ts";
import { arenaTabCounts, leaderboardChangeWindow, leaderboardSourceRows } from "../lib/leaderboard/source.ts";

const flags = new Set(process.argv.slice(2));
if ([...flags].some((flag) => flag !== "--full" && flag !== "--recalibrate")) {
  throw new Error("Usage: materialize-leaderboards.mjs [--full|--recalibrate]");
}
const forceFull = flags.has("--full") || flags.has("--recalibrate");
const recalibrate = flags.has("--recalibrate");

function exclusionFingerprint(db, cycleId = null) {
  const hash = createHash("sha256");
  const sql = cycleId == null ? "SELECT aid FROM excluded_players ORDER BY aid" : `
    SELECT aid FROM (
      SELECT aid FROM excluded_players
      UNION SELECT aid FROM players_db.excluded_players
      UNION SELECT aid FROM player_profiles WHERE mode='seasonal' AND cycle_id=? AND confirmed_banned=1
    ) ORDER BY aid`;
  for (const row of db.prepare(sql).iterate(...(cycleId == null ? [] : [cycleId]))) hash.update(`${row.aid}\n`);
  return hash.digest("hex");
}

function currentGeneration(db, scope) {
  const row = db.prepare(`SELECT c.generation,c.generated_at,g.formula_version,g.params_json
    FROM leaderboard_current c JOIN leaderboard_generations g ON g.scope=c.scope AND g.generation=c.generation
    WHERE c.scope=?`).get(scope);
  return row ? { generation: Number(row.generation), generatedAt: Number(row.generated_at),
    formulaVersion: Number(row.formula_version), params: JSON.parse(String(row.params_json)) } : null;
}

function fullIterables(source, config, formula) {
  const context = { config, formula };
  return {
    members: { *[Symbol.iterator]() {
      for (const row of leaderboardSourceRows(source, config)) yield materializeCandidate(row, context).member;
    } },
    orders: { *[Symbol.iterator]() {
      for (const row of leaderboardSourceRows(source, config)) yield* materializeCandidate(row, context).orders;
    } },
  };
}

let players;
let progression;
let publication;
try {
  players = new DatabaseSync(process.env.SQLITE_PATH || "/data/players.db");
  players.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=30000;");
  const { created: journalCreated } = initializeProfileChangeJournal(players);
  publication = new DatabaseSync(leaderboardPublicationPath());
  publication.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA temp_store=FILE;");
  initializeLeaderboardSchema(publication);
  const configs = leaderboardScopeConfigs();
  let seasonalJournalCreated = false;
  if (configs.some((config) => config.mode === "pvp-season")) {
    const progressionPath = process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db";
    if (!existsSync(progressionPath)) throw new Error(`seasonal source database not found at ${progressionPath}`);
    progression = new DatabaseSync(progressionPath);
    progression.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=30000;");
    ({ created: seasonalJournalCreated } = initializeSeasonalSchema(progression));
    progression.prepare("ATTACH DATABASE ? AS players_db").run(process.env.SQLITE_PATH || "/data/players.db");
  }
  for (const mode of ["regular", "pve", "arena", "pvp-season"]) {
    const modeConfigs = configs.filter((config) => config.mode === mode);
    if (modeConfigs.length === 0) continue;
    const source = mode === "pvp-season" ? progression : players;
    const cycleId = mode === "pvp-season" ? modeConfigs[0].cycleId : null;
    const cursorMode = cycleId == null ? mode : `seasonal:${cycleId}`;
    const cursor = leaderboardSourceCursor(publication, cursorMode);
    const sourceJournalCreated = mode === "pvp-season" ? seasonalJournalCreated : journalCreated;
    let sourceTransaction = false;
    try {
      const currents = new Map(modeConfigs.map((config) => [config.scope, currentGeneration(publication, config.scope)]));
      source.exec("BEGIN");
      sourceTransaction = true;
      const window = leaderboardChangeWindow(source, mode, cursor.changeId, cycleId);
      const bans = exclusionFingerprint(source, cycleId);
      const tabs = mode === "arena" ? arenaTabCounts(source) : null;
      for (let index = 0; index < modeConfigs.length; index += 1) {
        const config = modeConfigs[index];
        const startedAt = Date.now();
        beginLeaderboardPublication(publication, config.scope, startedAt);
        const current = currents.get(config.scope);
        const fullReason = leaderboardFullReason({ current, config, formulaVersion: LEADERBOARD_FORMULA_VERSION,
          metricVersion: LEADERBOARD_METRIC_VERSION, exclusionFingerprint: bans, forceFull,
          journalCreated: sourceJournalCreated || !cursor.initialized });
        let full = fullReason != null;
        let formula = current?.params.formula ?? null;
        const mustRecalculate = recalibrate || sourceJournalCreated || !cursor.initialized || !current ||
          leaderboardConfigChanged(current?.params, config) ||
          current?.formulaVersion !== LEADERBOARD_FORMULA_VERSION ||
          current?.params.metricVersion !== LEADERBOARD_METRIC_VERSION || current?.params.exclusionFingerprint !== bans;
        if (config.primaryMetric === "performance" && (mustRecalculate || (!formula && window.changes.length > 0))) {
          const available = referenceFormula(leaderboardSourceRows(source, config), config.activityCutoffMs);
          if (mustRecalculate || available) formula = available;
          if (!current?.params.formula && available) full = true;
        }
        const params = { ...config, formula, metricVersion: LEADERBOARD_METRIC_VERSION, exclusionFingerprint: bans };
        const metadata = { formulaVersion: LEADERBOARD_FORMULA_VERSION, params,
          meta: { arenaTabs: config.mode === "arena" ? tabs : null } };
        const finalScope = index === modeConfigs.length - 1;
        const sourceCursor = finalScope ? { mode: cursorMode, changeId: window.cutoff } : undefined;
        let result;
        if (full) {
          const iterables = fullIterables(source, config, formula);
          result = { kind: "full", ...publishLeaderboardScope(publication, config.scope, metadata,
            iterables.members, iterables.orders, startedAt, undefined, sourceCursor,
            current ? { generation: current.generation, generatedAt: current.generatedAt } : null) };
        } else {
          const candidates = window.changes.map(({ aid }) => {
            const next = leaderboardSourceRows(source, config, aid)[Symbol.iterator]().next();
            if (next.done) return { aid, member: null, orders: [] };
            return { aid, ...materializeCandidate(next.value, { config, formula }) };
          });
          result = { kind: "incremental", ...updateLeaderboardScope(publication, config.scope,
            current.generation, metadata, candidates, startedAt, sourceCursor, current.generatedAt) };
        }
        console.log(JSON.stringify({ scope: config.scope, fullReason, sourceChanges: window.changes.length,
          durationMs: Date.now() - startedAt, ...result }));
      }
      source.exec("COMMIT");
      sourceTransaction = false;
    } catch (error) {
      if (sourceTransaction) source.exec("ROLLBACK");
      for (const config of modeConfigs) failLeaderboardPublication(publication, config.scope, error);
      throw error;
    }
  }
} finally {
  players?.close();
  progression?.close();
  publication?.close();
}
