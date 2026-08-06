#!/usr/bin/env node

/*
 * Idempotent bridge for the average-player rollout.  It never creates a
 * snapshot by copying PvP combat data: Seasonal JSON is requeued for the
 * normal validated capture boundary, while the only values copied from the
 * regular store are lifetime hours and achievement ids.
 *
 * Run with --experimental-strip-types --experimental-sqlite.  Set
 * SEASONAL_BACKFILL_FETCH=true together with the existing operator sync
 * variables to process the queued Seasonal JSON immediately; otherwise the
 * script safely leaves profile tasks queued for the collector/operator.
 */
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import process from "node:process";

const { loadSeasonalCycleConfig } = await import("../lib/seasonal/config.ts");
const { initializeSeasonalSchema } = await import("../lib/seasonal/storage.ts");

const progressionPath = process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db";
const playersPath = process.env.SQLITE_PATH || "/data/players.db";
if (!existsSync(progressionPath)) throw new Error(`progression database does not exist: ${progressionPath}`);

const cycle = loadSeasonalCycleConfig();
if (!cycle) throw new Error("SEASONAL_CYCLE_ID, dates, and upstream contract are required");

const progression = new DatabaseSync(progressionPath);
const players = existsSync(playersPath) && playersPath !== progressionPath ? new DatabaseSync(playersPath) : null;
try {
  progression.exec("PRAGMA busy_timeout = 30000");
  initializeSeasonalSchema(progression);

  const profiles = progression.prepare(`SELECT aid, profile_updated_at
    FROM player_profiles
    WHERE mode = 'seasonal' AND cycle_id = ? AND confirmed_banned = 0
    ORDER BY aid`).all(cycle.cycleId);
  const limit = Number(process.env.SEASONAL_BACKFILL_LIMIT || 0);
  const selected = limit > 0 ? profiles.slice(0, limit) : profiles;
  const now = Date.now();
  const enqueue = progression.prepare(`INSERT INTO scan_tasks (
      mode, cycle_id, aid, kind, priority, state, previous_profile_updated_at,
      available_at, created_at, updated_at
    ) VALUES ('seasonal', ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
    ON CONFLICT(mode, cycle_id, aid, kind) DO UPDATE SET
      priority = MIN(scan_tasks.priority, excluded.priority),
      previous_profile_updated_at = COALESCE(excluded.previous_profile_updated_at, scan_tasks.previous_profile_updated_at),
      available_at = MIN(scan_tasks.available_at, excluded.available_at),
      state = CASE WHEN scan_tasks.state IN ('queued', 'leased') THEN scan_tasks.state ELSE 'queued' END,
      lease_owner = CASE WHEN scan_tasks.state = 'leased' THEN scan_tasks.lease_owner ELSE NULL END,
      leased_until = CASE WHEN scan_tasks.state = 'leased' THEN scan_tasks.leased_until ELSE NULL END,
      consecutive_errors = CASE WHEN scan_tasks.state IN ('queued', 'leased') THEN scan_tasks.consecutive_errors ELSE 0 END,
      updated_at = excluded.updated_at`);
  const updateEnrichment = progression.prepare(`UPDATE player_profiles SET
      lifetime_pvp_hours = CASE
        WHEN linked_pvp_profile_updated_at IS NULL OR linked_pvp_profile_updated_at <= ?
      THEN ? ELSE lifetime_pvp_hours END,
      linked_pvp_achievements = CASE
        WHEN linked_pvp_profile_updated_at IS NULL OR linked_pvp_profile_updated_at <= ?
        THEN ? ELSE linked_pvp_achievements END,
      linked_pvp_achievement_count = CASE
        WHEN linked_pvp_profile_updated_at IS NULL OR linked_pvp_profile_updated_at <= ?
          THEN ? ELSE linked_pvp_achievement_count END,
      linked_pvp_profile_updated_at = CASE
        WHEN linked_pvp_profile_updated_at IS NULL OR linked_pvp_profile_updated_at <= ?
          THEN ? ELSE linked_pvp_profile_updated_at END
    WHERE mode = 'seasonal' AND cycle_id = ? AND aid = ? AND confirmed_banned = 0`);

  let profileTasks = 0;
  let linkedTasks = 0;
  let enriched = 0;
  progression.exec("BEGIN IMMEDIATE");
  try {
    for (const row of selected) {
      const aid = Number(row.aid);
      const updatedAt = Number(row.profile_updated_at);
      enqueue.run(cycle.cycleId, aid, "profile", 1, updatedAt, now, now, now);
      enqueue.run(cycle.cycleId, aid, "linked_pvp", 2, null, now, now, now);
      profileTasks += 1;
      linkedTasks += 1;

      const pvp = players?.prepare(`SELECT hours, achievements, profile_updated_at
        FROM players WHERE aid = ?`).get(aid);
      const hours = pvp?.hours == null ? null : Number(pvp.hours);
      const pvpUpdatedAt = pvp?.profile_updated_at == null ? null : Number(pvp.profile_updated_at);
      if (hours == null || !Number.isFinite(hours) || hours < 0 || pvpUpdatedAt == null || pvpUpdatedAt <= 0) continue;
      let achievementIds = [];
      try {
        const parsed = JSON.parse(String(pvp.achievements ?? "[]"));
        if (Array.isArray(parsed)) achievementIds = parsed.filter((id) => typeof id === "string");
      } catch {
        achievementIds = [];
      }
      updateEnrichment.run(pvpUpdatedAt, hours, pvpUpdatedAt, JSON.stringify(achievementIds),
        pvpUpdatedAt, achievementIds.length, pvpUpdatedAt, pvpUpdatedAt, cycle.cycleId, aid);
      enriched += 1;
    }
    progression.exec("COMMIT");
  } catch (error) {
    progression.exec("ROLLBACK");
    throw error;
  }

  const fetchEnabled = process.env.SEASONAL_BACKFILL_FETCH === "true";
  const fetchSummary = fetchEnabled
    ? await syncSeasonalJson(selected, cycle.cycleId)
    : { attempted: 0, completed: 0, skipped: selected.length };
  console.log(JSON.stringify({
    cycleId: cycle.cycleId,
    selected: selected.length,
    profileTasks,
    linkedTasks,
    enriched,
    fetch: fetchSummary,
    idempotent: true,
  }));
} finally {
  players?.close();
  progression.close();
}

async function syncSeasonalJson(rows, cycleId) {
  const base = process.env.SEASONAL_PROFILE_SYNC_BASE_URL || process.env.REGULAR_PROFILE_SYNC_BASE_URL;
  const secret = process.env.PROFILE_REFRESH_SECRET || "";
  if (!base || secret.length < 32) return { attempted: 0, completed: 0, skipped: rows.length };
  const endpoint = new URL("/api/operator/seasonal/profile-sync", base).href;
  let completed = 0;
  for (const row of rows) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ aid: Number(row.aid), cycleId, expectedUpdatedAt: Number(row.profile_updated_at) }),
    });
    if (response.ok || response.status === 409) completed += 1;
  }
  return { attempted: rows.length, completed, skipped: 0 };
}
