// @ts-expect-error Node's strip-types runtime requires the explicit extension.
import { initializeSeasonalSchema } from "./seasonal/storage.ts";
// @ts-expect-error Node's strip-types runtime requires the explicit extension.
import { materializePersistentProgression, PERSISTENT_CYCLE_ID } from "./regular-progression.ts";

export interface PveProgressionSeedResult {
  scanned: number;
  inserted: number;
  skipped: number;
}

interface StoredPvePlayer {
  aid: unknown;
  profile_updated_at: unknown;
  fetched_at: unknown;
  stats_json: unknown;
  achievements: unknown;
}

interface PveSeedInput {
  aid: number;
  upstreamUpdatedAt: number;
  capturedAt: number;
  stats: Record<string, unknown>;
  achievementIds: string[];
}

const INSERT_SQL = `INSERT INTO progression_snapshots (
  mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at, local_date,
  series_id, nickname, side, prestige, level,
  experience, hours, total_raids, pmc_raids, scav_raids, survived, deaths, pmc_deaths,
  total_kills, killed_pmc, run_through, longest_win_streak, achv_count, achievements, stats_json
) VALUES (${Array.from({ length: 27 }, () => "?").join(", ")})`;

function seedInput(row: StoredPvePlayer): PveSeedInput | null {
  const aid = Number(row.aid);
  const upstreamUpdatedAt = Number(row.profile_updated_at);
  const capturedAt = Number(row.fetched_at);
  if (!Number.isSafeInteger(aid) || aid <= 0 ||
      !Number.isFinite(upstreamUpdatedAt) || upstreamUpdatedAt <= 0 ||
      !Number.isFinite(capturedAt) || capturedAt <= 0) return null;
  try {
    const stats = JSON.parse(String(row.stats_json)) as Record<string, unknown>;
    const counters = ["experience", "pmcRaids", "scavRaids", "pmcSurvived", "pmcDeaths", "pmcKills", "killedPmc"];
    if (!stats || typeof stats !== "object" || Array.isArray(stats) ||
        counters.some((field) => !Number.isFinite(Number(stats[field])) || Number(stats[field]) < 0)) return null;
    let achievementIds: string[] = [];
    try {
      const parsed = JSON.parse(String(row.achievements ?? "[]"));
      if (Array.isArray(parsed)) achievementIds = parsed.filter((value): value is string => typeof value === "string");
    } catch {
      // A malformed achievement list must not discard an otherwise valid baseline.
    }
    return { aid, upstreamUpdatedAt, capturedAt, stats, achievementIds };
  } catch {
    return null;
  }
}

function args(input: PveSeedInput): unknown[] {
  const stats = input.stats;
  return [
    "pve", PERSISTENT_CYCLE_ID, input.aid, input.upstreamUpdatedAt, input.upstreamUpdatedAt, input.capturedAt,
    new Date(input.upstreamUpdatedAt).toISOString().slice(0, 10), 1,
    stats.nickname ?? null, stats.side ?? null, stats.prestige ?? null, stats.level ?? null,
    stats.experience, stats.hoursPlayed ?? null, stats.totalRaids ?? null, stats.pmcRaids,
    stats.scavRaids, stats.survivedRaids ?? null, stats.deaths ?? null, stats.pmcDeaths,
    stats.totalKills ?? null, stats.killedPmc, stats.runThrough ?? null, stats.longestWinStreak ?? null,
    stats.achievementsCount ?? null, JSON.stringify(input.achievementIds), JSON.stringify(stats),
  ];
}

/**
 * Creates one current baseline per stored PvE profile without inferring a
 * historic interval. A pre-existing snapshot always wins.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function seedPveProgressionBaselines(progressionDb: any, playersDb: any): PveProgressionSeedResult {
  initializeSeasonalSchema(progressionDb);
  const rows = playersDb.prepare(`SELECT aid, profile_updated_at, fetched_at, stats_json, achievements
    FROM mode_players WHERE mode = 'pve' ORDER BY aid`).all() as StoredPvePlayer[];
  const hasSnapshot = progressionDb.prepare(`SELECT 1 FROM progression_snapshots
    WHERE mode = 'pve' AND cycle_id = ? AND aid = ? LIMIT 1`);
  const insert = progressionDb.prepare(INSERT_SQL);
  let inserted = 0;
  progressionDb.exec("SAVEPOINT seed_pve_progression_baselines");
  try {
    for (const row of rows) {
      const input = seedInput(row);
      if (!input || hasSnapshot.get(PERSISTENT_CYCLE_ID, input.aid)) continue;
      insert.run(...args(input));
      inserted += 1;
    }
    if (inserted) materializePersistentProgression(progressionDb, "pve");
    progressionDb.exec("RELEASE seed_pve_progression_baselines");
  } catch (error) {
    progressionDb.exec("ROLLBACK TO seed_pve_progression_baselines");
    progressionDb.exec("RELEASE seed_pve_progression_baselines");
    throw error;
  }
  return { scanned: rows.length, inserted, skipped: rows.length - inserted };
}
