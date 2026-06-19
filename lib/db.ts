import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { ParsedPlayerStats } from "@/types/tarkov";
import { bracketFor } from "@/lib/brackets";

let warnedNoDb = false;
let warnedCtx = false;

/**
 * Returns the D1 binding, or null when it isn't available (e.g. the database
 * hasn't been created/bound yet). Storage is best-effort: a missing binding
 * must never break a profile lookup.
 */
export function getDB(): D1Database | null {
  try {
    const { env } = getCloudflareContext();
    if (!env.DB) {
      if (!warnedNoDb) {
        warnedNoDb = true;
        console.warn(
          "getDB: DB binding is missing — storage disabled. Check wrangler.jsonc d1_databases and that migrations are applied."
        );
      }
      return null;
    }
    return env.DB;
  } catch (e) {
    if (!warnedCtx) {
      warnedCtx = true;
      console.warn("getDB: Cloudflare context unavailable — storage disabled.", e);
    }
    return null;
  }
}

/**
 * Upserts one collected player keyed by account id. Re-looking up the same
 * player UPDATES the existing row (so they're counted once, always current),
 * which removes the view-weighting bias in any derived bracket aggregates.
 */
export async function upsertPlayer(
  db: D1Database,
  aid: number,
  stats: ParsedPlayerStats,
  achievementIds: string[]
): Promise<void> {
  const bracketKey = bracketFor(stats.hoursPlayed).key;

  await db
    .prepare(
      `INSERT INTO players (
        aid, nickname, side, prestige, level, experience, hours, bracket_key,
        total_raids, pmc_raids, scav_raids, survived, deaths, pmc_deaths,
        total_kills, killed_pmc, run_through, longest_win_streak,
        kd_ratio, pmc_kd_ratio, survival_rate, kills_per_raid,
        achv_count, achievements, fetched_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
        ?9, ?10, ?11, ?12, ?13, ?14,
        ?15, ?16, ?17, ?18,
        ?19, ?20, ?21, ?22,
        ?23, ?24, ?25
      )
      ON CONFLICT(aid) DO UPDATE SET
        nickname = excluded.nickname,
        side = excluded.side,
        prestige = excluded.prestige,
        level = excluded.level,
        experience = excluded.experience,
        hours = excluded.hours,
        bracket_key = excluded.bracket_key,
        total_raids = excluded.total_raids,
        pmc_raids = excluded.pmc_raids,
        scav_raids = excluded.scav_raids,
        survived = excluded.survived,
        deaths = excluded.deaths,
        pmc_deaths = excluded.pmc_deaths,
        total_kills = excluded.total_kills,
        killed_pmc = excluded.killed_pmc,
        run_through = excluded.run_through,
        longest_win_streak = excluded.longest_win_streak,
        kd_ratio = excluded.kd_ratio,
        pmc_kd_ratio = excluded.pmc_kd_ratio,
        survival_rate = excluded.survival_rate,
        kills_per_raid = excluded.kills_per_raid,
        achv_count = excluded.achv_count,
        achievements = excluded.achievements,
        fetched_at = excluded.fetched_at`
    )
    .bind(
      aid,
      stats.nickname,
      stats.side,
      stats.prestige,
      stats.level,
      stats.experience,
      stats.hoursPlayed,
      bracketKey,
      stats.totalRaids,
      stats.pmcRaids,
      stats.scavRaids,
      stats.survivedRaids,
      stats.deaths,
      stats.pmcDeaths,
      stats.totalKills,
      stats.killedPmc,
      stats.runThrough,
      stats.longestWinStreak,
      stats.kdRatio,
      stats.pmcKdRatio,
      stats.survivalRate,
      stats.killsPerRaid,
      stats.achievementsCount,
      JSON.stringify(achievementIds),
      Date.now()
    )
    .run();
}
