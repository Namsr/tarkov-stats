import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { bracketFor } from "../lib/brackets.ts";
import { scoreCheater } from "../lib/cheater-score.ts";
import { saveRiskEvaluation } from "../lib/admin/moderation-db.ts";

const playersPath = process.env.SQLITE_PATH || "/data/players.db";
const progressionPath = process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db";

function parsedJson(value, fallback) {
  try { return JSON.parse(String(value ?? "")); } catch { return fallback; }
}

function statsFromRow(row) {
  const stored = parsedJson(row.stats_json, {});
  return {
    nickname: String(stored.nickname ?? row.nickname ?? ""),
    level: Number(stored.level ?? row.level ?? 0),
    prestige: Number(stored.prestige ?? row.prestige ?? 0),
    experience: Number(stored.experience ?? row.experience ?? 0),
    side: String(stored.side ?? row.side ?? ""),
    totalRaids: Number(stored.totalRaids ?? row.total_raids ?? 0),
    pmcRaids: Number(stored.pmcRaids ?? row.pmc_raids ?? 0),
    scavRaids: Number(stored.scavRaids ?? row.scav_raids ?? 0),
    survivedRaids: Number(stored.survivedRaids ?? row.survived ?? 0),
    survivalRate: Number(stored.survivalRate ?? row.survival_rate ?? 0),
    totalKills: Number(stored.totalKills ?? row.total_kills ?? 0),
    killedPmc: Number(stored.killedPmc ?? row.killed_pmc ?? 0),
    killsPerRaid: Number(stored.killsPerRaid ?? row.kills_per_raid ?? 0),
    kdRatio: Number(stored.kdRatio ?? row.kd_ratio ?? 0),
    pmcKdRatio: Number(stored.pmcKdRatio ?? row.pmc_kd_ratio ?? 0),
    deaths: Number(stored.deaths ?? row.deaths ?? 0),
    pmcDeaths: Number(stored.pmcDeaths ?? row.pmc_deaths ?? 0),
    runThrough: Number(stored.runThrough ?? row.run_through ?? 0),
    pmcSurvived: Number(stored.pmcSurvived ?? row.pmc_survived ?? 0),
    pmcSurvivalRate: Number(stored.pmcSurvivalRate ?? row.pmc_survival_rate ?? 0),
    pmcKills: Number(stored.pmcKills ?? row.pmc_kills ?? 0),
    pmcKillsPerRaid: Number(stored.pmcKillsPerRaid ?? row.pmc_kills_per_raid ?? 0),
    pmcExitKilled: Number(stored.pmcExitKilled ?? 0),
    pmcExitLeft: Number(stored.pmcExitLeft ?? 0),
    pmcExitTransit: Number(stored.pmcExitTransit ?? 0),
    pmcExitMia: Number(stored.pmcExitMia ?? 0),
    hoursPlayed: Number(stored.hoursPlayed ?? row.hours ?? row.lifetime_pvp_hours ?? 0),
    longestWinStreak: Number(stored.longestWinStreak ?? row.longest_win_streak ?? 0),
    achievementsCount: Number(stored.achievementsCount ?? row.achv_count ?? 0),
    registrationDate: Number(stored.registrationDate ?? 0),
    lastActiveDate: Number(stored.lastActiveDate ?? 0),
    profileUpdatedAt: Number(stored.profileUpdatedAt ?? row.profile_updated_at ?? 0),
    avgLifespan: Number(stored.avgLifespan ?? 0),
    totalLootValue: Number(stored.totalLootValue ?? 0),
  };
}

const achievementBaselines = new Map();
const baselines = new Map();
const playersDb = existsSync(playersPath) ? new DatabaseSync(playersPath, { readOnly: true }) : null;

function sourceFor(mode) {
  return mode === "regular"
    ? { table: "players", modeWhere: "", params: [] }
    : { table: "mode_players", modeWhere: "p.mode = ? AND ", params: [mode] };
}

function baselineFor(mode, bracket) {
  if (!playersDb) return null;
  const source = sourceFor(mode);
  const columns = ["pmc_survival_rate", "pmc_kd_ratio", "pmc_kills_per_raid", "longest_win_streak"];
  const moments = columns.flatMap((column) => [
    `COUNT(CASE WHEN ${column} > 0 THEN 1 END) cnt_${column}`,
    `AVG(CASE WHEN ${column} > 0 THEN ${column} END) mean_${column}`,
    `AVG(CASE WHEN ${column} > 0 THEN ${column} * ${column} END) square_${column}`,
  ]).join(", ");
  const upper = bracket.hi == null ? "" : "AND p.hours < ?";
  const row = playersDb.prepare(`SELECT COUNT(*) n, ${moments} FROM ${source.table} p
    WHERE ${source.modeWhere}p.hours >= ? ${upper}
      AND NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = p.aid)`)
    .get(...source.params, bracket.lo, ...(bracket.hi == null ? [] : [bracket.hi]));
  return {
    n: Number(row.n),
    metrics: Object.fromEntries(columns.map((column) => {
      const mean = Number(row[`mean_${column}`] ?? 0);
      const square = Number(row[`square_${column}`] ?? 0);
      return [column, { n: Number(row[`cnt_${column}`]), mean, std: Math.sqrt(Math.max(0, square - mean * mean)) }];
    })),
  };
}

function achievementInputFor(mode) {
  if (!playersDb) return null;
  const source = sourceFor(mode);
  const where = `${source.modeWhere}p.achievements IS NOT NULL AND p.achievements != ''
    AND NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = p.aid)`;
  const total = Number(playersDb.prepare(`SELECT COUNT(*) n FROM ${source.table} p WHERE
    ${source.modeWhere}NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = p.aid)`)
    .get(...source.params).n);
  const rows = playersDb.prepare(`WITH expanded AS (
      SELECT je.value id, p.hours FROM ${source.table} p, json_each(p.achievements) je WHERE ${where}
    ), ranked AS (
      SELECT id, hours, COUNT(*) OVER (PARTITION BY id) owners,
        AVG(hours) OVER (PARTITION BY id) mean_hours,
        ROW_NUMBER() OVER (PARTITION BY id ORDER BY hours) rn FROM expanded
    ) SELECT id, MAX(owners) owners, MAX(mean_hours) mean_hours,
      MIN(CASE WHEN rn = CAST((owners + 4) / 5 AS INTEGER) THEN hours END) early_hours
      FROM ranked GROUP BY id`).all(...source.params);
  return { total, stats: rows.map((row) => ({
    id: String(row.id), owners: Number(row.owners),
    samplePct: total > 0 ? Number(row.owners) / total * 100 : 0,
    meanHours: Number(row.mean_hours), earlyHours: Number(row.early_hours ?? row.mean_hours),
  })) };
}

async function scoreRow(row, mode, cycleId) {
  const baselineMode = mode === "seasonal" ? "regular" : mode;
  const stats = statsFromRow(row);
  const bracket = bracketFor(stats.hoursPlayed);
  const baselineKey = `${baselineMode}:${bracket.key}`;
  if (!baselines.has(baselineKey)) {
    baselines.set(baselineKey, baselineFor(baselineMode, bracket));
  }
  if (!achievementBaselines.has(baselineMode)) {
    achievementBaselines.set(baselineMode, achievementInputFor(baselineMode));
  }
  const achievementBaseline = achievementBaselines.get(baselineMode);
  const achievementIds = parsedJson(row.achievements, []).filter((id) => typeof id === "string");
  const result = scoreCheater(stats, baselines.get(baselineKey), achievementBaseline ? {
    ownedIds: achievementIds,
    stats: achievementBaseline.stats,
  } : null);
  await saveRiskEvaluation({
    aid: Number(row.aid), mode, cycleId, score: result.score, tier: result.tier,
    factors: result.factors, scoreVersion: 1,
    profileUpdatedAt: Number(stats.profileUpdatedAt) || 0,
  });
}

let scored = 0;
if (playersDb) {
  try {
    for (const row of playersDb.prepare(`SELECT p.* FROM players p
      WHERE NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = p.aid)`).iterate()) {
      await scoreRow(row, "regular", "persistent");
      scored += 1;
    }
    for (const row of playersDb.prepare(`SELECT p.* FROM mode_players p
      WHERE NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = p.aid)`).iterate()) {
      await scoreRow(row, String(row.mode), "persistent");
      scored += 1;
    }
  } finally { /* kept open for Seasonal baseline scoring below */ }
}

if (existsSync(progressionPath)) {
  const db = new DatabaseSync(progressionPath, { readOnly: true });
  try {
    const hasProfiles = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'player_profiles'").get();
    if (hasProfiles) {
      const sql = `SELECT s.*, p.lifetime_pvp_hours FROM progression_snapshots s
        JOIN player_profiles p ON p.mode = s.mode AND p.cycle_id = s.cycle_id AND p.aid = s.aid
        WHERE s.mode = 'seasonal' AND p.confirmed_banned = 0
          AND s.profile_updated_at = (SELECT MAX(latest.profile_updated_at)
            FROM progression_snapshots latest WHERE latest.mode = s.mode
              AND latest.cycle_id = s.cycle_id AND latest.aid = s.aid)
          AND NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = s.aid)`;
      for (const row of db.prepare(sql).iterate()) {
        await scoreRow(row, "seasonal", String(row.cycle_id));
        scored += 1;
      }
    }
  } finally { db.close(); }
}

playersDb?.close();

console.log(JSON.stringify({ scored }));
