import { initializeSeasonalSchema } from "@/lib/seasonal/storage";
import {
  buildProgressionSeries,
  PROGRESSION_KINDS,
  progressionDailySql,
  queryRegularProgressionAverage,
  queryProgressionSeriesBundle,
  type DailyRow,
  type ProgressionRequest,
} from "@/lib/seasonal/progression";
import { d1Rows, getSeasonalD1 } from "@/lib/seasonal/d1";
import { loadSeasonalCycleConfig } from "@/lib/seasonal/config";
import { upsertD1SeasonCycle } from "@/lib/seasonal/storage-d1";
import { upsertSqliteSeasonCycle } from "@/lib/seasonal/storage";
import { scoreCheater, type CheaterScoreResult } from "@/lib/cheater-score";
import { getStore } from "@/lib/db";
import { rangeForHours } from "@/lib/playtime-brackets";
import {
  buildSeasonalProgressionDetails,
  type ProgressionDetailIntervalRow,
  type SeasonalProgressionDetails,
} from "@/lib/seasonal/progression-details";
import type { ParsedPlayerStats } from "@/types/tarkov";
import type {
  ProgressionAverageResponse,
  ProgressionKind,
  ProgressionSeriesResponse,
} from "@/types/seasonal";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let database: any = null;

type ProgressionQueryResult = (ProgressionSeriesResponse & SeasonalProgressionDetails) | null;
type ProgressionIdentity = Omit<ProgressionRequest, "kind">;
export type ProgressionBundle = Record<ProgressionKind, Exclude<ProgressionQueryResult, null>>;

interface DetailDbRow extends Record<string, unknown> {
  aid: number;
  local_date: string;
  ended_at: number;
  elapsed_days: number;
  status: "valid" | "reset" | "schema_anomaly";
  experience: number;
  pmc_raids: number;
  scav_raids: number;
  pmc_survived: number;
  pmc_deaths: number;
  pmc_kills: number;
  killed_pmc: number;
}

interface StaticProfileRow extends Record<string, unknown> {
  nickname: string;
  experience: number;
  pmc_raids: number;
  scav_raids: number;
  pmc_survived: number;
  pmc_deaths: number;
  pmc_kills: number;
  killed_pmc: number;
  lifetime_pvp_hours: number | null;
  prestige: number;
  longest_win_streak: number;
  achievements: string;
}

const DETAIL_INTERVAL_SQL = `WITH target_dates AS (
    SELECT DISTINCT local_date FROM progression_intervals
    WHERE mode = ? AND cycle_id = ? AND aid = ? AND status = 'valid'
  )
  SELECT i.aid, i.local_date, i.ended_at, i.elapsed_days, i.status,
    i.experience, i.pmc_raids, i.scav_raids, i.pmc_survived, i.pmc_deaths,
    i.pmc_kills, i.killed_pmc
  FROM progression_intervals i
  JOIN target_dates d ON d.local_date = i.local_date
  JOIN player_profiles p ON p.mode = i.mode AND p.cycle_id = i.cycle_id AND p.aid = i.aid
    AND p.confirmed_banned = 0
  WHERE i.mode = ? AND i.cycle_id = ? AND i.status = 'valid'
  ORDER BY i.local_date, i.aid, i.ended_at`;

const STATIC_PROFILE_SQL = `SELECT p.nickname, p.experience, p.pmc_raids, p.scav_raids,
  p.pmc_survived, p.pmc_deaths, p.pmc_kills, p.killed_pmc, p.lifetime_pvp_hours,
  COALESCE(s.prestige, 0) AS prestige,
  COALESCE(s.longest_win_streak, 0) AS longest_win_streak,
  COALESCE(s.achievements, '[]') AS achievements
  FROM player_profiles p LEFT JOIN progression_snapshots s ON s.id = (
    SELECT latest.id FROM progression_snapshots latest
    WHERE latest.mode = p.mode AND latest.cycle_id = p.cycle_id AND latest.aid = p.aid
    ORDER BY latest.profile_updated_at DESC, latest.id DESC LIMIT 1
  ) WHERE p.mode = ? AND p.cycle_id = ? AND p.aid = ?
    AND p.confirmed_banned = 0`;

function detailRows(rows: DetailDbRow[], input: ProgressionRequest): ProgressionDetailIntervalRow[] {
  return rows.map((row) => ({
    mode: input.mode,
    cycleId: input.cycleId,
    aid: Number(row.aid),
    localDate: String(row.local_date),
    endedAt: Number(row.ended_at),
    elapsedDays: Number(row.elapsed_days),
    status: row.status,
    changes: {
      experience: Number(row.experience),
      pmcRaids: Number(row.pmc_raids),
      scavRaids: Number(row.scav_raids),
      pmcSurvived: Number(row.pmc_survived),
      pmcDeaths: Number(row.pmc_deaths),
      pmcKills: Number(row.pmc_kills),
      killedPmc: Number(row.killed_pmc),
    },
  }));
}

function achievementIds(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((item): item is string => typeof item === "string"))]
      : [];
  } catch {
    return [];
  }
}

async function trustedStaticScore(row: StaticProfileRow): Promise<CheaterScoreResult> {
  const raids = Number(row.pmc_raids);
  const survived = Number(row.pmc_survived);
  const deaths = Number(row.pmc_deaths);
  const kills = Number(row.pmc_kills);
  const killedPmc = Number(row.killed_pmc);
  const ratio = (value: number, denominator: number) => denominator === 0 ? value : value / denominator;
  const stats: ParsedPlayerStats = {
    nickname: String(row.nickname), level: 0, prestige: Number(row.prestige), experience: Number(row.experience), side: "PMC",
    totalRaids: raids + Number(row.scav_raids), pmcRaids: raids, scavRaids: Number(row.scav_raids),
    survivedRaids: survived, survivalRate: raids > 0 ? (survived / raids) * 100 : 0,
    totalKills: kills, killedPmc, killsPerRaid: raids > 0 ? kills / raids : 0, kdRatio: ratio(kills, deaths),
    pmcKdRatio: ratio(killedPmc, deaths), deaths, pmcDeaths: deaths, runThrough: 0,
    pmcSurvived: survived, pmcSurvivalRate: raids > 0 ? (survived / raids) * 100 : 0,
    pmcKills: kills, pmcKillsPerRaid: raids > 0 ? kills / raids : 0, pmcExitKilled: 0, pmcExitLeft: 0,
    pmcExitTransit: 0, pmcExitMia: 0, hoursPlayed: Number(row.lifetime_pvp_hours ?? 0),
    longestWinStreak: Number(row.longest_win_streak), achievementsCount: achievementIds(row.achievements).length,
    registrationDate: 0, lastActiveDate: 0,
    avgLifespan: 0, totalLootValue: 0,
  };
  try {
    const store = await getStore();
    if (!store) return scoreCheater(stats, null);
    const bracket = rangeForHours(stats.hoursPlayed);
    const [baseline, achievementBaseline] = await Promise.all([
      store.baseline(bracket.min, bracket.max),
      store.achievementBaseline(),
    ]);
    const ownedIds = achievementIds(row.achievements);
    const achievements = achievementBaseline.total > 0 ? {
      ownedIds,
      stats: achievementBaseline.achievements.map((entry) => ({
        id: entry.ach_id,
        owners: entry.owners,
        samplePct: (entry.owners / achievementBaseline.total) * 100,
        meanHours: entry.meanHours,
        earlyHours: entry.earlyHours,
      })),
    } : null;
    return scoreCheater(stats, baseline, achievements);
  } catch (error) {
    console.warn("Seasonal static risk baseline unavailable: " + (error as Error).message);
    return scoreCheater(stats, null);
  }
}

async function details(input: ProgressionRequest, intervals: DetailDbRow[], profile: StaticProfileRow): Promise<SeasonalProgressionDetails> {
  const staticRisk = await trustedStaticScore(profile);
  return buildSeasonalProgressionDetails({
    mode: input.mode,
    cycleId: input.cycleId,
    aid: input.aid,
    trustedStaticScore: staticRisk.score,
    staticReasons: staticRisk.factors.filter((factor) => factor.points >= 1).map((factor) => factor.key),
    intervals: detailRows(intervals, input),
  });
}

function progressionHistory(
  row: Record<string, unknown> | null | undefined,
  intervalCount: number,
): ProgressionSeriesResponse["history"] {
  return {
    snapshotCount: Number(row?.snapshots ?? 0),
    intervalCount,
    ready: intervalCount >= 2,
    firstObservedAt: row?.first_observed_at == null ? null : Number(row.first_observed_at),
    lastObservedAt: row?.last_observed_at == null ? null : Number(row.last_observed_at),
  };
}

function mergeProgressionBundle(
  series: Record<ProgressionKind, ProgressionSeriesResponse>,
  history: ProgressionSeriesResponse["history"],
  sharedDetails: SeasonalProgressionDetails,
): ProgressionBundle {
  return Object.fromEntries(PROGRESSION_KINDS.map((kind) => [
    kind,
    { ...series[kind], history, ...sharedDetails },
  ])) as ProgressionBundle;
}

export async function getProgressionBundleQuery(): Promise<((input: ProgressionIdentity) => Promise<ProgressionBundle | null>) | null> {
  try {
    const d1 = await getSeasonalD1();
    const configuredCycle = loadSeasonalCycleConfig();
    if (d1) {
      if (configuredCycle) await upsertD1SeasonCycle(d1, configuredCycle);
      return async (input) => {
        if (input.mode === "regular") return null;
        const cycle = await d1.prepare("SELECT starts_at FROM season_cycles WHERE mode = 'seasonal' AND cycle_id = ?")
          .bind(input.cycleId).first() as { starts_at: number } | null;
        if (!cycle) return null;
        const [results, intervalResult, profile, history, validIntervals] = await Promise.all([
          Promise.all(PROGRESSION_KINDS.map((kind) => d1.prepare(progressionDailySql(kind))
            .bind("seasonal", input.cycleId, "seasonal", input.cycleId, input.aid).all())),
          d1.prepare(DETAIL_INTERVAL_SQL).bind("seasonal", input.cycleId, input.aid, "seasonal", input.cycleId).all(),
          d1.prepare(STATIC_PROFILE_SQL).bind("seasonal", input.cycleId, input.aid).first() as Promise<StaticProfileRow | null>,
          d1.prepare(`SELECT COUNT(*) snapshots, MIN(profile_updated_at) first_observed_at,
            MAX(profile_updated_at) last_observed_at FROM progression_snapshots
            WHERE mode = 'seasonal' AND cycle_id = ? AND aid = ?`).bind(input.cycleId, input.aid).first(),
          d1.prepare(`SELECT COUNT(*) intervals FROM progression_intervals
            WHERE mode = 'seasonal' AND cycle_id = ? AND aid = ? AND status = 'valid'
              AND (experience != 0 OR pmc_raids != 0 OR scav_raids != 0 OR pmc_survived != 0
                OR pmc_deaths != 0 OR pmc_kills != 0 OR killed_pmc != 0)`).bind(input.cycleId, input.aid).first(),
        ]);
        if (!profile) return null;
        const series = Object.fromEntries(PROGRESSION_KINDS.map((kind, index) => [
          kind,
          buildProgressionSeries(
            d1Rows(results[index]) as unknown as DailyRow[],
            { ...input, kind },
          ),
        ])) as Record<ProgressionKind, ProgressionSeriesResponse>;
        const intervalCount = Number((validIntervals as Record<string, unknown> | null)?.intervals ?? 0);
        const detailInput = { ...input, kind: "cumulative" as const };
        return mergeProgressionBundle(
          series,
          progressionHistory(history as Record<string, unknown> | null, intervalCount),
          await details(detailInput, d1Rows(intervalResult) as unknown as DetailDbRow[], profile),
        );
      };
    }
    if (!database) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sqlite = (await import("node:sqlite" as string)) as any;
      database = new sqlite.DatabaseSync(process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db");
      initializeSeasonalSchema(database);
    }
    if (configuredCycle) upsertSqliteSeasonCycle(database, configuredCycle);
    return async (input) => {
      const series = queryProgressionSeriesBundle(database, input);
      if (!series) return null;
      const mode = input.mode;
      const profile = database.prepare(STATIC_PROFILE_SQL).get(mode, input.cycleId, input.aid) as StaticProfileRow | undefined;
      if (!profile) return null;
      const intervals = database.prepare(DETAIL_INTERVAL_SQL)
        .all(mode, input.cycleId, input.aid, mode, input.cycleId) as DetailDbRow[];
      const history = database.prepare(`SELECT COUNT(*) snapshots, MIN(profile_updated_at) first_observed_at,
        MAX(profile_updated_at) last_observed_at FROM progression_snapshots
        WHERE mode = ? AND cycle_id = ? AND aid = ?`).get(mode, input.cycleId, input.aid) as Record<string, unknown>;
      const validIntervals = database.prepare(`SELECT COUNT(*) intervals FROM progression_intervals
        WHERE mode = ? AND cycle_id = ? AND aid = ? AND status = 'valid'
          AND (experience != 0 OR pmc_raids != 0 OR scav_raids != 0 OR pmc_survived != 0
            OR pmc_deaths != 0 OR pmc_kills != 0 OR killed_pmc != 0)`)
        .get(mode, input.cycleId, input.aid) as { intervals: number };
      const intervalCount = Number(validIntervals.intervals);
      const detailInput = { ...input, kind: "cumulative" as const };
      return mergeProgressionBundle(
        series,
        progressionHistory(history, intervalCount),
        await details(detailInput, intervals, profile),
      );
    };
  } catch (error) {
    console.warn("progression query: sqlite unavailable: " + (error as Error).message);
    return null;
  }
}

export async function getProgressionQuery(): Promise<((input: ProgressionRequest) => Promise<ProgressionQueryResult>) | null> {
  const queryBundle = await getProgressionBundleQuery();
  if (!queryBundle) return null;
  return async (input) => {
    const bundle = await queryBundle({
      mode: input.mode,
      cycleId: input.cycleId,
      aid: input.aid,
    });
    return bundle?.[input.kind] ?? null;
  };
}

export async function getRegularProgressionAverage(): Promise<ProgressionAverageResponse | null> {
  try {
    if (await getSeasonalD1()) return null;
    if (!database) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sqlite = (await import("node:sqlite" as string)) as any;
      database = new sqlite.DatabaseSync(process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db");
      initializeSeasonalSchema(database);
    }
    return queryRegularProgressionAverage(database);
  } catch (error) {
    console.warn("regular progression average unavailable: " + (error as Error).message);
    return null;
  }
}
