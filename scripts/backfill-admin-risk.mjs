import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { bracketFor } from "../lib/brackets.ts";
import { scoreCheater } from "../lib/cheater-score.ts";
import { saveRiskEvaluation } from "../lib/admin/moderation-db.ts";
import { adminRiskScoreVersionForMode, pveRiskNeedsZero } from "../lib/admin/risk-version.ts";
import {
  COMPARISON_COHORT_PERCENTAGES,
  comparisonRangeFor,
  selectComparisonPercent,
} from "../lib/profile-cohort.ts";

const playersPath = process.env.SQLITE_PATH || "/data/players.db";
const progressionPath = process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db";

function parsedJson(value, fallback) {
  try { return JSON.parse(String(value ?? "")); } catch { return fallback; }
}

function statsFromRow(row, mode) {
  const stored = parsedJson(row.stats_json, {});
  const pve = mode === "pve";
  const numberValue = (storedKey, rowKey, fallback = 0) => {
    const storedValue = stored[storedKey];
    const rowValue = rowKey == null ? undefined : row[rowKey];
    if (pve && (storedValue == null || !Object.prototype.hasOwnProperty.call(stored, storedKey))) return Number.NaN;
    return Number(storedValue ?? rowValue ?? fallback);
  };
  return {
    nickname: String(stored.nickname ?? row.nickname ?? ""),
    level: numberValue("level", "level"),
    prestige: numberValue("prestige", "prestige"),
    experience: numberValue("experience", "experience"),
    side: String(stored.side ?? row.side ?? ""),
    totalRaids: numberValue("totalRaids", "total_raids"),
    pmcRaids: numberValue("pmcRaids", "pmc_raids"),
    scavRaids: numberValue("scavRaids", "scav_raids"),
    survivedRaids: numberValue("survivedRaids", "survived"),
    survivalRate: numberValue("survivalRate", "survival_rate"),
    totalKills: numberValue("totalKills", "total_kills"),
    killedPmc: numberValue("killedPmc", "killed_pmc"),
    killsPerRaid: numberValue("killsPerRaid", "kills_per_raid"),
    kdRatio: numberValue("kdRatio", "kd_ratio"),
    pmcKdRatio: numberValue("pmcKdRatio", "pmc_kd_ratio"),
    deaths: numberValue("deaths", "deaths"),
    pmcDeaths: numberValue("pmcDeaths", "pmc_deaths"),
    runThrough: numberValue("runThrough", "run_through"),
    pmcSurvived: numberValue("pmcSurvived", "pmc_survived"),
    pmcSurvivalRate: numberValue("pmcSurvivalRate", "pmc_survival_rate"),
    pmcKills: numberValue("pmcKills", "pmc_kills"),
    pmcKillsPerRaid: numberValue("pmcKillsPerRaid", "pmc_kills_per_raid"),
    pmcExitKilled: numberValue("pmcExitKilled", null),
    pmcExitLeft: numberValue("pmcExitLeft", null),
    pmcExitTransit: numberValue("pmcExitTransit", null),
    pmcExitMia: numberValue("pmcExitMia", null),
    hoursPlayed: numberValue("hoursPlayed", "hours", 0),
    longestWinStreak: numberValue("longestWinStreak", "longest_win_streak"),
    achievementsCount: numberValue("achievementsCount", "achv_count"),
    registrationDate: numberValue("registrationDate", null),
    lastActiveDate: numberValue("lastActiveDate", null),
    profileUpdatedAt: numberValue("profileUpdatedAt", "profile_updated_at"),
    avgLifespan: numberValue("avgLifespan", null),
    totalLootValue: numberValue("totalLootValue", null),
    pvpStatsKnown: pve
      ? stored.pvpStatsKnown === true
      : typeof stored.pvpStatsKnown === "boolean"
        ? stored.pvpStatsKnown
        : row.pvp_stats_known == null || Number(row.pvp_stats_known) !== 0,
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

const RISK_COLUMNS = ["pmc_survival_rate", "pmc_kd_ratio", "pmc_kills_per_raid", "longest_win_streak"];
const RISK_MOMENTS = RISK_COLUMNS.flatMap((column) => [
  `COUNT(CASE WHEN ${column} > 0 THEN 1 END) cnt_${column}`,
  `AVG(CASE WHEN ${column} > 0 THEN ${column} END) mean_${column}`,
  `AVG(CASE WHEN ${column} > 0 THEN ${column} * ${column} END) square_${column}`,
]).join(", ");

function toBaseline(row) {
  return {
    n: Number(row?.n ?? 0),
    metrics: Object.fromEntries(RISK_COLUMNS.map((column) => {
      const mean = Number(row?.[`mean_${column}`] ?? 0);
      const square = Number(row?.[`square_${column}`] ?? 0);
      return [column, { n: Number(row?.[`cnt_${column}`] ?? 0), mean, std: Math.sqrt(Math.max(0, square - mean * mean)) }];
    })),
  };
}

function pveBaselineFor(stats, aid) {
  if (!Number.isSafeInteger(stats.pmcRaids) || stats.pmcRaids <= 0 || !(stats.hoursPlayed > 0)) return null;
  const center = { hours: stats.hoursPlayed, pmcRaids: stats.pmcRaids };
  const ranges = COMPARISON_COHORT_PERCENTAGES.map((percent) => comparisonRangeFor(center, percent));
  const populationWhere = `p.hours > 0 AND p.pmc_raids > 0 AND p.aid != ?`;
  const rangeParams = (percent) => {
    const range = comparisonRangeFor(center, percent);
    return [range.hours.min, range.hours.max, range.pmcRaids.min, range.pmcRaids.max];
  };
  const row = playersDb.prepare(`SELECT ${COMPARISON_COHORT_PERCENTAGES.map((percent) =>
    `SUM(CASE WHEN p.hours >= ? AND p.hours <= ? AND p.pmc_raids >= ? AND p.pmc_raids <= ? THEN 1 ELSE 0 END) count_${percent}`
  ).join(", ")} FROM mode_players p
    WHERE p.mode = 'pve' AND ${populationWhere}
      AND NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = p.aid)`)
    .get(...ranges.flatMap((range) => [range.hours.min, range.hours.max, range.pmcRaids.min, range.pmcRaids.max]), aid);
  const counts = Object.fromEntries(COMPARISON_COHORT_PERCENTAGES.map((percent) => [
    percent,
    Number(row?.[`count_${percent}`] ?? 0),
  ]));
  const selectedPercent = selectComparisonPercent(counts, 30);
  const matched = counts[selectedPercent] >= 30;
  const load = (where, params) => playersDb.prepare(`SELECT COUNT(*) n, ${RISK_MOMENTS}
    FROM mode_players p WHERE p.mode = 'pve' AND ${where}
      AND NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = p.aid)`).get(...params);
  let baseline = toBaseline(matched
    ? load(`${populationWhere} AND p.hours >= ? AND p.hours <= ? AND p.pmc_raids >= ? AND p.pmc_raids <= ?`, [
      ...rangeParams(selectedPercent), aid,
    ])
    : load(populationWhere, [aid]));
  if (matched && baseline.n < 30) baseline = toBaseline(load(populationWhere, [aid]));
  return baseline;
}

function baselineFor(mode, stats, aid) {
  if (!playersDb) return null;
  if (mode === "pve") return pveBaselineFor(stats, aid);
  const bracket = bracketFor(stats.hoursPlayed);
  const source = sourceFor(mode);
  const upper = bracket.hi == null ? "" : "AND p.hours < ?";
  const row = playersDb.prepare(`SELECT COUNT(*) n, ${RISK_MOMENTS} FROM ${source.table} p
    WHERE ${source.modeWhere}p.hours >= ? ${upper}
      AND NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = p.aid)`)
    .get(...source.params, bracket.lo, ...(bracket.hi == null ? [] : [bracket.hi]));
  return toBaseline(row);
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

function zeroRiskResult(stats) {
  const result = scoreCheater(stats, null, null);
  return {
    score: 0,
    tier: "low",
    factors: result.factors.map((factor) => ({ ...factor, value: Number.isFinite(factor.value) ? factor.value : 0, points: 0, z: null, available: false })),
    sampleN: 0,
    basedOnSample: false,
  };
}

async function scoreRow(row, mode, cycleId) {
  const baselineMode = mode === "seasonal" ? "regular" : mode;
  const stats = statsFromRow(row, mode);
  const aid = Number(row.aid);
  const zeroRisk = mode === "pve" && pveRiskNeedsZero(stats);
  const bracket = bracketFor(stats.hoursPlayed);
  const baselineKey = baselineMode === "pve"
    ? `${baselineMode}:${stats.hoursPlayed}:${stats.pmcRaids}:${aid}`
    : `${baselineMode}:${bracket.key}`;
  if (!zeroRisk && !baselines.has(baselineKey)) {
    baselines.set(baselineKey, baselineFor(baselineMode, stats, aid));
  }
  if (!zeroRisk && !achievementBaselines.has(baselineMode)) {
    achievementBaselines.set(baselineMode, achievementInputFor(baselineMode));
  }
  const achievementBaseline = achievementBaselines.get(baselineMode);
  const achievementIds = parsedJson(row.achievements, []).filter((id) => typeof id === "string");
  const result = zeroRisk ? zeroRiskResult(stats) : scoreCheater(stats, baselines.get(baselineKey), achievementBaseline ? {
    ownedIds: achievementIds,
    stats: achievementBaseline.stats,
  } : null);
  await saveRiskEvaluation({
    aid, mode, cycleId, score: result.score, tier: result.tier,
    factors: result.factors, scoreVersion: adminRiskScoreVersionForMode(mode),
    profileUpdatedAt: Number(stats.profileUpdatedAt) || 0,
    sampleN: result.sampleN,
    confidence: Math.min(1, result.sampleN / 30),
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
      WHERE p.mode = 'pve'
        AND NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = p.aid)`).iterate()) {
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
