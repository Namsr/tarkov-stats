import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { bracketFor } from "../lib/brackets.ts";
import { hasValidRiskInputs, scoreCheater, scoreSeasonalCheater } from "../lib/cheater-score.ts";
import { riskScoreVersion } from "../lib/admin/risk-version.ts";
import {
  COMPARISON_COHORT_PERCENTAGES,
  RISK_COHORT_TARGET,
  comparisonRangeFor,
  selectComparisonPercent,
} from "../lib/profile-cohort.ts";
import { getSeasonalAchievementBaseline, getSeasonalRiskBaseline } from "../lib/seasonal/average-db.ts";
import { saveRiskEvaluation } from "../lib/admin/moderation-db.ts";

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
  const stats = {
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
    hoursPlayed: numberValue("hoursPlayed", "hours"),
    longestWinStreak: numberValue("longestWinStreak", "longest_win_streak"),
    achievementsCount: numberValue("achievementsCount", "achv_count"),
    registrationDate: numberValue("registrationDate", null),
    lastActiveDate: numberValue("lastActiveDate", null),
    profileUpdatedAt: numberValue("profileUpdatedAt", "profile_updated_at"),
    avgLifespan: numberValue("avgLifespan", null),
    totalLootValue: numberValue("totalLootValue", null),
  };
  if (mode === "regular" || mode === "pve") {
    const known = pve ? stored.pvpStatsKnown : stored.pvpStatsKnown ?? row.pvp_stats_known;
    stats.pvpStatsKnown = known === true || known === 1 || known === "1";
  }
  return stats;
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

function pveRiskBaselineFor(stats, aid) {
  if (!playersDb || !Number.isFinite(stats.pmcRaids) || stats.pmcRaids <= 0 || !(stats.hoursPlayed > 0)) return null;
  const center = { hours: stats.hoursPlayed, pmcRaids: stats.pmcRaids };
  const ranges = COMPARISON_COHORT_PERCENTAGES.map((percent) => comparisonRangeFor(center, percent));
  const populationWhere = "p.hours > 0 AND p.pmc_raids > 0 AND p.aid != ?";
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
  const selectedPercent = selectComparisonPercent(counts, RISK_COHORT_TARGET);
  const matched = counts[selectedPercent] >= RISK_COHORT_TARGET;
  const load = (where, params) => playersDb.prepare(`SELECT COUNT(*) n, ${RISK_MOMENTS}
    FROM mode_players p WHERE p.mode = 'pve' AND ${where}
      AND NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = p.aid)`).get(...params);
  let baseline = toBaseline(matched
    ? load(`${populationWhere} AND p.hours >= ? AND p.hours <= ? AND p.pmc_raids >= ? AND p.pmc_raids <= ?`, [
      aid, ...rangeParams(selectedPercent),
    ])
    : load(populationWhere, [aid]));
  if (matched && baseline.n < RISK_COHORT_TARGET) baseline = toBaseline(load(populationWhere, [aid]));
  return baseline;
}

function regularRiskBaselineFor(stats, excludeAid) {
  if (!playersDb || !Number.isFinite(stats.hoursPlayed) || !Number.isFinite(stats.pmcRaids) || stats.hoursPlayed <= 0 || stats.pmcRaids <= 0) {
    return null;
  }
  const source = sourceFor("regular");
  const modeWhere = source.modeWhere.replace(/ AND $/, "");
  const ranges = COMPARISON_COHORT_PERCENTAGES.map((percent) => comparisonRangeFor({
    hours: stats.hoursPlayed,
    pmcRaids: stats.pmcRaids,
  }, percent));
  const cutoff = Date.now() - 90 * 86_400_000;
  const common = [
    ...(modeWhere ? [modeWhere] : []),
    "p.hours > 0",
    "p.pmc_raids > 0",
    "p.aid != ?",
    "p.pvp_stats_known = 1",
    "p.profile_updated_at >= ?",
    "NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = p.aid)",
  ].join(" AND ");
  const commonParams = [...source.params, excludeAid, Math.floor(cutoff)];
  const countColumns = COMPARISON_COHORT_PERCENTAGES.map((percent) =>
    `SUM(CASE WHEN p.hours >= ? AND p.hours <= ? AND p.pmc_raids >= ? AND p.pmc_raids <= ? THEN 1 ELSE 0 END) AS count_${percent}`
  ).join(", ");
  const countRow = playersDb.prepare(`SELECT ${countColumns} FROM ${source.table} p WHERE ${common}`)
    .get(...ranges.flatMap((range) => [range.hours.min, range.hours.max, range.pmcRaids.min, range.pmcRaids.max]), ...commonParams);
  const counts = Object.fromEntries(COMPARISON_COHORT_PERCENTAGES.map((percent) => [
    percent,
    Number(countRow?.[`count_${percent}`] ?? 0),
  ]));
  const selectedPercent = selectComparisonPercent(counts, RISK_COHORT_TARGET);
  const selectedRange = ranges.find((range) => range.percent === selectedPercent);
  const matched = counts[selectedPercent] >= RISK_COHORT_TARGET;
  const where = matched
    ? `${common} AND p.hours >= ? AND p.hours <= ? AND p.pmc_raids >= ? AND p.pmc_raids <= ?`
    : common;
  const params = matched
    ? [...commonParams, selectedRange.hours.min, selectedRange.hours.max, selectedRange.pmcRaids.min, selectedRange.pmcRaids.max]
    : commonParams;
  const row = playersDb.prepare(`SELECT COUNT(*) n, ${RISK_MOMENTS} FROM ${source.table} p WHERE ${where}`).get(...params);
  return toBaseline(row);
}

function legacyBaselineFor(mode, bracket) {
  if (!playersDb) return null;
  const source = sourceFor(mode);
  const upper = bracket.hi == null ? "" : "AND p.hours < ?";
  const row = playersDb.prepare(`SELECT COUNT(*) n, ${RISK_MOMENTS} FROM ${source.table} p
    WHERE ${source.modeWhere}p.hours >= ? ${upper}
      AND NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = p.aid)`)
    .get(...source.params, bracket.lo, ...(bracket.hi == null ? [] : [bracket.hi]));
  return toBaseline(row);
}

function baselineFor(mode, stats, aid) {
  if (!playersDb) return null;
  if (mode === "pve") return pveRiskBaselineFor(stats, aid);
  if (mode === "regular") return regularRiskBaselineFor(stats, aid);
  return bracketFor(stats.hoursPlayed) ? legacyBaselineFor("regular", bracketFor(stats.hoursPlayed)) : null;
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
  const stats = statsFromRow(row, mode);
  const aid = Number(row.aid);
  const canScore = Number.isFinite(stats.hoursPlayed) && stats.hoursPlayed > 0 &&
    Number.isFinite(stats.pmcRaids) && stats.pmcRaids > 0 && hasValidRiskInputs(stats);
  const baselineKey = mode === "regular"
    ? `regular:${stats.hoursPlayed}:${stats.pmcRaids}:${aid}`
    : mode === "pve"
      ? `pve:${stats.hoursPlayed}:${stats.pmcRaids}:${aid}`
      : `seasonal:${cycleId}:${stats.hoursPlayed}`;
  if (canScore && !baselines.has(baselineKey)) {
    baselines.set(
      baselineKey,
      mode === "regular"
        ? regularRiskBaselineFor(stats, Number(row.aid))
        : baselineFor(mode, stats, aid),
    );
  }
  if (canScore && !achievementBaselines.has(mode)) achievementBaselines.set(mode, achievementInputFor(mode));
  const baseline = baselines.get(baselineKey) ?? null;
  const achievementBaseline = achievementBaselines.get(mode) ?? null;
  const achievementIds = parsedJson(row.achievements, []).filter((id) => typeof id === "string");
  const achievementInput = achievementBaseline ? {
    ownedIds: achievementIds,
    stats: achievementBaseline.stats,
  } : null;
  const hasUsableMetrics = baseline != null && baseline.n > 0 && Object.values(baseline.metrics).some((metric) =>
    metric.n > 0 && Number.isFinite(metric.mean) && Number.isFinite(metric.std)
  );
  const result = canScore && hasUsableMetrics && hasValidRiskInputs(stats)
    ? scoreCheater(stats, baseline, achievementInput)
    : scoreCheater({ ...stats, pmcRaids: 0 }, null, null);
  await saveRiskEvaluation({
    aid, mode, cycleId, score: result.score, tier: result.tier,
    factors: result.factors, scoreVersion: riskScoreVersion(mode, cycleId),
    profileUpdatedAt: Number(stats.profileUpdatedAt) || 0,
    sampleN: result.sampleN,
    confidence: Math.min(1, result.sampleN / 30),
  });
}

async function scoreSeasonalRow(row, cycleId) {
  const baseStats = statsFromRow(row);
  const pmcRaids = Number(row.pmc_raids);
  const pmcSurvived = Number(row.pmc_survived);
  const pmcDeaths = Number(row.pmc_deaths);
  const pmcKills = Number(row.pmc_kills);
  const killedPmc = Number(row.killed_pmc);
  const stats = {
    ...baseStats,
    pmcRaids,
    pmcSurvived,
    pmcDeaths,
    pmcKills,
    killedPmc,
    pmcKillsPerRaid: pmcRaids > 0 ? pmcKills / pmcRaids : 0,
    pmcKdRatio: pmcDeaths > 0 ? killedPmc / pmcDeaths : killedPmc,
    pmcSurvivalRate: pmcRaids > 0 ? pmcSurvived / pmcRaids * 100 : 0,
  };
  const [baseline, achievementBaseline] = await Promise.all([
    getSeasonalRiskBaseline(cycleId, {
      hours: stats.hoursPlayed,
      pmcRaids: stats.pmcRaids,
    }, Number(row.aid)),
    getSeasonalAchievementBaseline(cycleId, Number(row.aid)),
  ]);
  const ownedIds = parsedJson(row.achievements, []).filter((id) => typeof id === "string");
  const result = scoreSeasonalCheater(stats, baseline, achievementBaseline ? {
    ownedIds,
    seasonal: true,
    playerUnlockDays: {},
    stats: achievementBaseline.achievements.map((achievement) => ({
      id: achievement.ach_id,
      owners: achievement.owners,
      eligibleN: achievement.eligibleN,
      samplePct: achievement.prevalencePct,
      meanHours: achievement.meanHours,
      earlyHours: achievement.earlyHours,
      unlockDayP20: achievement.unlockDayP20,
    })),
  } : null);
  await saveRiskEvaluation({
    aid: Number(row.aid), mode: "seasonal", cycleId, score: result.score, tier: result.tier,
    factors: result.factors, scoreVersion: riskScoreVersion("seasonal", cycleId),
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
      WHERE p.mode = 'pve'
        AND NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = p.aid)`).iterate()) {
      await scoreRow(row, String(row.mode), "persistent");
      scored += 1;
    }
  } finally { }
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
        await scoreSeasonalRow(row, String(row.cycle_id));
        scored += 1;
      }
    }
  } finally { db.close(); }
}

playersDb?.close();

console.log(JSON.stringify({ scored }));
