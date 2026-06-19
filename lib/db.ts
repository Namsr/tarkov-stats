import type { ParsedPlayerStats } from "@/types/tarkov";
import { bracketFor } from "@/lib/brackets";

// Minimal structural type for the subset of the D1 API we use. Avoids depending
// on Cloudflare's global types, which aren't present in a plain Node/Docker build.
interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): { run(): Promise<unknown> };
  };
}

let warnedNoDb = false;
let warnedCtx = false;

/**
 * Returns the D1 binding when running on Cloudflare, or null otherwise — e.g.
 * the self-hosted Node/Docker build, where there is no D1. Storage is
 * best-effort: a missing binding must never break a profile lookup.
 */
export async function getDB(): Promise<D1Like | null> {
  try {
    const mod = await import("@opennextjs/cloudflare");
    const { env } = mod.getCloudflareContext();
    const db = (env as { DB?: D1Like }).DB;
    if (!db) {
      if (!warnedNoDb) {
        warnedNoDb = true;
        console.warn("getDB: no D1 binding — player storage disabled.");
      }
      return null;
    }
    return db;
  } catch {
    if (!warnedCtx) {
      warnedCtx = true;
      console.warn(
        "getDB: Cloudflare context unavailable — player storage disabled (expected on self-host)."
      );
    }
    return null;
  }
}

/**
 * Upserts one collected player keyed by account id. Re-looking up the same
 * player UPDATES the existing row (counted once, always current).
 */
export async function upsertPlayer(
  db: D1Like,
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
