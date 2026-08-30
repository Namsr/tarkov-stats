/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-ignore -- Node's strip-types test runner requires the extension; Next accepts it.
import type {
  CaptureSnapshotResult,
  ProgressionIntervalRecord,
  ScanTaskRecord,
  SeasonalStore,
  SeasonCycle,
} from "../../types/seasonal.ts";
// @ts-ignore -- Node's strip-types test runner requires the extension; Next accepts it.
import type { D1DatabaseLike } from "./d1.ts";
// @ts-ignore -- Node's strip-types test runner requires the extension; Next accepts it.
import { d1Changes, d1Rows } from "./d1.ts";
// @ts-ignore -- Node's strip-types test runner requires the extension; Next accepts it.
import { counterArgs, identityObject, moscowDate, profilePortraitArgs, seasonalAchievementSnapshotValue, seasonalCommonSkillsSnapshotValue, seasonalWeaponMasterySnapshotValue, toProfile, toScanTask, toSnapshot, rowCounters, validateProfile, validateTaskIdentity, validateTaskKind, validateTaskPriority } from "./storage.ts";

const IDENTITY = "mode = ? AND cycle_id = ? AND aid = ?";

export async function upsertD1SeasonCycle(db: D1DatabaseLike, cycle: SeasonCycle): Promise<void> {
  await db.prepare(`INSERT INTO season_cycles (mode, cycle_id, starts_at, ends_at, enabled, upstream_contract)
    VALUES ('seasonal', ?, ?, ?, ?, ?)
    ON CONFLICT(mode, cycle_id) DO UPDATE SET starts_at = excluded.starts_at,
      ends_at = excluded.ends_at, enabled = excluded.enabled, upstream_contract = excluded.upstream_contract`)
    .bind(cycle.cycleId, cycle.startsAt, cycle.endsAt, cycle.enabled ? 1 : 0, cycle.upstreamContract).run();
}

/** D1 implementation of the same narrow contract used by self-hosted SQLite. */
export function createD1SeasonalStore(db: D1DatabaseLike): SeasonalStore {
  return {
    async getCycle(cycleId) {
      const row = await db.prepare("SELECT * FROM season_cycles WHERE mode = 'seasonal' AND cycle_id = ?")
        .bind(cycleId).first() as Record<string, unknown> | null;
      return row ? {
        mode: "seasonal", cycleId: String(row.cycle_id), startsAt: Number(row.starts_at),
        endsAt: row.ends_at == null ? null : Number(row.ends_at), enabled: Number(row.enabled) === 1,
        upstreamContract: row.upstream_contract == null ? null : String(row.upstream_contract) as SeasonCycle["upstreamContract"],
      } : null;
    },

    async getProfile(identity) {
      const row = await db.prepare(`SELECT * FROM player_profiles WHERE ${IDENTITY}`)
        .bind(identity.mode, identity.cycleId, identity.aid).first() as Record<string, unknown> | null;
      if (!row) return null;
      const snapshot = await db.prepare(`SELECT * FROM progression_snapshots WHERE ${IDENTITY} ORDER BY profile_updated_at DESC LIMIT 1`)
        .bind(identity.mode, identity.cycleId, identity.aid).first() as Record<string, unknown> | null;
      return toProfile(row, snapshot ?? undefined);
    },

    async upsertProfile(profile, observedAt = Date.now()) {
      validateProfile(profile);
      await db.prepare(`
        INSERT INTO player_profiles (
          mode, cycle_id, aid, nickname, profile_updated_at, last_access_at, lifetime_pvp_hours,
          experience, pmc_raids, scav_raids, pmc_survived, pmc_deaths, pmc_kills, killed_pmc,
          total_raids, survived, deaths, total_kills, longest_win_streak, level,
          first_seen_at, last_seen_at, confirmed_banned
        ) VALUES (${Array.from({ length: 22 }, () => "?").join(", ")},
          EXISTS(SELECT 1 FROM excluded_players WHERE aid = ?))
        ON CONFLICT(mode, cycle_id, aid) DO UPDATE SET
          nickname = excluded.nickname,
          profile_updated_at = MAX(player_profiles.profile_updated_at, excluded.profile_updated_at),
          last_access_at = MAX(player_profiles.last_access_at, excluded.last_access_at),
          lifetime_pvp_hours = COALESCE(player_profiles.lifetime_pvp_hours, excluded.lifetime_pvp_hours),
          experience = CASE WHEN excluded.profile_updated_at >= player_profiles.profile_updated_at THEN excluded.experience ELSE player_profiles.experience END,
          pmc_raids = CASE WHEN excluded.profile_updated_at >= player_profiles.profile_updated_at THEN excluded.pmc_raids ELSE player_profiles.pmc_raids END,
          scav_raids = CASE WHEN excluded.profile_updated_at >= player_profiles.profile_updated_at THEN excluded.scav_raids ELSE player_profiles.scav_raids END,
          pmc_survived = CASE WHEN excluded.profile_updated_at >= player_profiles.profile_updated_at THEN excluded.pmc_survived ELSE player_profiles.pmc_survived END,
          pmc_deaths = CASE WHEN excluded.profile_updated_at >= player_profiles.profile_updated_at THEN excluded.pmc_deaths ELSE player_profiles.pmc_deaths END,
          pmc_kills = CASE WHEN excluded.profile_updated_at >= player_profiles.profile_updated_at THEN excluded.pmc_kills ELSE player_profiles.pmc_kills END,
          killed_pmc = CASE WHEN excluded.profile_updated_at >= player_profiles.profile_updated_at THEN excluded.killed_pmc ELSE player_profiles.killed_pmc END,
          total_raids = CASE WHEN excluded.profile_updated_at >= player_profiles.profile_updated_at THEN excluded.total_raids ELSE player_profiles.total_raids END,
          survived = CASE WHEN excluded.profile_updated_at >= player_profiles.profile_updated_at THEN excluded.survived ELSE player_profiles.survived END,
          deaths = CASE WHEN excluded.profile_updated_at >= player_profiles.profile_updated_at THEN excluded.deaths ELSE player_profiles.deaths END,
          total_kills = CASE WHEN excluded.profile_updated_at >= player_profiles.profile_updated_at THEN excluded.total_kills ELSE player_profiles.total_kills END,
          longest_win_streak = CASE WHEN excluded.profile_updated_at >= player_profiles.profile_updated_at THEN excluded.longest_win_streak ELSE player_profiles.longest_win_streak END,
          level = CASE WHEN excluded.profile_updated_at >= player_profiles.profile_updated_at THEN excluded.level ELSE player_profiles.level END,
          last_seen_at = MAX(player_profiles.last_seen_at, excluded.last_seen_at),
          confirmed_banned = CASE
            WHEN EXISTS(SELECT 1 FROM excluded_players WHERE aid = excluded.aid) THEN 1
            ELSE player_profiles.confirmed_banned END
      `).bind(profile.mode, profile.cycleId, profile.aid, profile.nickname, profile.profileUpdatedAt,
        profile.lastAccessAt, profile.lifetimePvpHours, ...counterArgs(profile.counters), ...profilePortraitArgs(profile), observedAt, observedAt,
        profile.aid).run();
      const row = await db.prepare(`SELECT * FROM player_profiles WHERE ${IDENTITY}`)
        .bind(profile.mode, profile.cycleId, profile.aid).first() as Record<string, unknown> | null;
      if (!row) throw new Error("Seasonal profile upsert failed");
      return toProfile(row);
    },

    async captureSnapshot(profile, capturedAt = Date.now()) {
      validateProfile(profile);
      const identity = [profile.mode, profile.cycleId, profile.aid] as const;
      if (await db.prepare("SELECT 1 FROM excluded_players WHERE aid = ?").bind(profile.aid).first()) {
        return { inserted: false, status: "banned", snapshot: null, interval: null } as CaptureSnapshotResult;
      }
      const previousRow = await db.prepare(`SELECT * FROM progression_snapshots WHERE ${IDENTITY} ORDER BY profile_updated_at DESC LIMIT 1`)
        .bind(...identity).first() as Record<string, unknown> | null;
      const previous = toSnapshot(previousRow ?? undefined);
      const commonSkillsSnapshot = seasonalCommonSkillsSnapshotValue(profile);
      const weaponMasterySnapshot = seasonalWeaponMasterySnapshotValue(profile);
      if (previous && profile.profileUpdatedAt <= previous.profileUpdatedAt) {
        // Replaying the same Seasonal JSON enriches the existing portrait but
        // remains progression-idempotent: no duplicate snapshot or interval.
        if (profile.profileUpdatedAt === previous.profileUpdatedAt && (
          profile.seasonalStats !== undefined ||
          profile.seasonalAchievements !== undefined ||
          commonSkillsSnapshot !== undefined ||
          weaponMasterySnapshot !== undefined ||
          profile.side !== undefined
        )) {
          const stats = profile.seasonalStats;
          const achievementSnapshot = seasonalAchievementSnapshotValue(profile);
          const portraitAssignments = stats === undefined ? "" : `
            total_raids = ?, survived = ?, deaths = ?, total_kills = ?, run_through = ?,
            level = ?, prestige = ?, longest_win_streak = ?,`;
          await db.prepare(`UPDATE progression_snapshots SET
            side = COALESCE(?, side),${portraitAssignments}
            achv_count = COALESCE(?, achv_count), achievements = COALESCE(?, achievements),
            common_skills = COALESCE(?, common_skills), weapon_mastery = COALESCE(?, weapon_mastery)
            WHERE ${IDENTITY} AND profile_updated_at = ?`).bind(
            profile.side ?? null,
            ...(stats === undefined ? [] : [
              stats.totalRaids, stats.survivedRaids, stats.deaths, stats.totalKills,
              stats.runThrough, stats.level, stats.prestige, stats.longestWinStreak,
            ]),
            achievementSnapshot.count, achievementSnapshot.value,
            commonSkillsSnapshot ?? null,
            weaponMasterySnapshot ?? null,
            ...identity, profile.profileUpdatedAt,
          ).run();
        }
        return { inserted: false, status: profile.profileUpdatedAt === previous.profileUpdatedAt ? "duplicate" : "stale", snapshot: null, interval: null };
      }

      const localDate = moscowDate(profile.profileUpdatedAt);
      const counters = counterArgs(profile.counters);
      const staticSignals = profile.staticSignals ?? {
        prestige: 0,
        longestWinStreak: 0,
        achievementIds: [],
      };
      const hasStaticSignals = profile.staticSignals !== undefined;
      const seasonalStats = profile.seasonalStats;
      const achievementSnapshot = seasonalAchievementSnapshotValue(profile);
      const snapshotValues = [
        profile.side ?? null,
        profile.counters.experience, seasonalStats?.totalRaids ?? null, profile.counters.pmcRaids,
        profile.counters.scavRaids, seasonalStats?.survivedRaids ?? null, profile.counters.pmcSurvived,
        seasonalStats?.deaths ?? null, profile.counters.pmcDeaths, profile.counters.pmcKills,
        seasonalStats?.totalKills ?? null, profile.counters.killedPmc, seasonalStats?.runThrough ?? null,
        seasonalStats?.level ?? null,
        seasonalStats !== undefined
          ? seasonalStats.prestige
          : hasStaticSignals ? staticSignals.prestige : null,
        seasonalStats !== undefined
          ? seasonalStats.longestWinStreak
          : hasStaticSignals ? staticSignals.longestWinStreak : null,
        achievementSnapshot.count,
        achievementSnapshot.value,
        commonSkillsSnapshot ?? null,
        weaponMasterySnapshot ?? null,
      ];
      const statements = [db.prepare(`INSERT INTO progression_snapshots (
        mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at, local_date, series_id,
        side, experience, total_raids, pmc_raids, scav_raids, survived, pmc_survived, deaths, pmc_deaths,
        pmc_kills, total_kills, killed_pmc, run_through, level, prestige, longest_win_streak, achv_count, achievements,
        common_skills, weapon_mastery
      ) SELECT ?, ?, ?, ?, ?, ?, ?, COALESCE((
          SELECT series_id + CASE WHEN
            ? < experience OR ? < pmc_raids OR ? < scav_raids OR ? < pmc_survived OR
            ? < pmc_deaths OR ? < pmc_kills OR ? < killed_pmc THEN 1 ELSE 0 END
          FROM progression_snapshots WHERE mode = ? AND cycle_id = ? AND aid = ?
            AND profile_updated_at < ? ORDER BY profile_updated_at DESC LIMIT 1
        ), 1), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM progression_snapshots WHERE mode = ? AND cycle_id = ? AND aid = ?
          AND profile_updated_at >= ?
      )
      ON CONFLICT(mode, cycle_id, aid, profile_updated_at) DO NOTHING`).bind(
        ...identity, profile.profileUpdatedAt, profile.profileUpdatedAt, capturedAt, localDate,
        ...counters, ...identity, profile.profileUpdatedAt, ...snapshotValues,
        ...identity, profile.profileUpdatedAt
      )];
      statements.push(db.prepare(`WITH current AS (
          SELECT * FROM progression_snapshots WHERE mode = ? AND cycle_id = ? AND aid = ? AND profile_updated_at = ?
        ), prior AS (
          SELECT * FROM progression_snapshots WHERE mode = ? AND cycle_id = ? AND aid = ? AND profile_updated_at < ?
          ORDER BY profile_updated_at DESC LIMIT 1
        )
        INSERT INTO progression_intervals (
          mode, cycle_id, aid, from_snapshot_id, to_snapshot_id, ended_at, local_date, elapsed_days,
          status, experience, pmc_raids, scav_raids, pmc_survived, pmc_deaths, pmc_kills, killed_pmc,
          confidence, score_version
        ) SELECT current.mode, current.cycle_id, current.aid, prior.id, current.id,
          current.profile_updated_at, current.local_date,
          (current.profile_updated_at - prior.profile_updated_at) / 86400000.0,
          CASE WHEN current.experience - prior.experience < 0 AND current.pmc_raids - prior.pmc_raids < 0 THEN 'reset'
            WHEN current.experience - prior.experience < 0 OR current.pmc_raids - prior.pmc_raids < 0
              OR current.scav_raids - prior.scav_raids < 0 OR current.pmc_survived - prior.pmc_survived < 0
              OR current.pmc_deaths - prior.pmc_deaths < 0 OR current.pmc_kills - prior.pmc_kills < 0
              OR current.killed_pmc - prior.killed_pmc < 0 THEN 'schema_anomaly' ELSE 'valid' END,
          current.experience - prior.experience, current.pmc_raids - prior.pmc_raids,
          current.scav_raids - prior.scav_raids, current.pmc_survived - prior.pmc_survived,
          current.pmc_deaths - prior.pmc_deaths, current.pmc_kills - prior.pmc_kills,
          current.killed_pmc - prior.killed_pmc,
          CASE WHEN current.experience >= prior.experience AND current.pmc_raids >= prior.pmc_raids
            AND current.scav_raids >= prior.scav_raids AND current.pmc_survived >= prior.pmc_survived
            AND current.pmc_deaths >= prior.pmc_deaths AND current.pmc_kills >= prior.pmc_kills
            AND current.killed_pmc >= prior.killed_pmc
            THEN MIN(1.0, 86400000.0 / (current.profile_updated_at - prior.profile_updated_at)) ELSE 0 END, 1
        FROM current CROSS JOIN prior WHERE 1
        ON CONFLICT(mode, cycle_id, aid, from_snapshot_id, to_snapshot_id) DO NOTHING`)
        .bind(...identity, profile.profileUpdatedAt, ...identity, profile.profileUpdatedAt));
      statements.push(db.prepare(`UPDATE player_profiles SET snapshot_count = (
        SELECT COUNT(*) FROM progression_snapshots s
        WHERE s.mode = player_profiles.mode AND s.cycle_id = player_profiles.cycle_id AND s.aid = player_profiles.aid
      ) WHERE ${IDENTITY}`).bind(...identity));
      const results = await db.batch(statements);
      if (d1Changes(results[0]) !== 1) {
        const latest = await db.prepare(`SELECT profile_updated_at FROM progression_snapshots WHERE ${IDENTITY}
          ORDER BY profile_updated_at DESC LIMIT 1`).bind(...identity).first() as { profile_updated_at: number } | null;
        return { inserted: false, status: Number(latest?.profile_updated_at) === profile.profileUpdatedAt ? "duplicate" : "stale", snapshot: null, interval: null };
      }
      const snapshotRow = await db.prepare(`SELECT * FROM progression_snapshots WHERE ${IDENTITY} AND profile_updated_at = ?`)
        .bind(...identity, profile.profileUpdatedAt).first() as Record<string, unknown> | null;
      const snapshot = toSnapshot(snapshotRow ?? undefined);
      if (!snapshot) throw new Error("Seasonal snapshot insert failed");
      let interval: ProgressionIntervalRecord | null = null;
      const intervalRow = await db.prepare("SELECT * FROM progression_intervals WHERE to_snapshot_id = ?")
        .bind(snapshot.id).first() as Record<string, unknown> | null;
      if (intervalRow) {
          interval = {
            ...identityObject(profile), id: Number(intervalRow.id), fromSnapshotId: Number(intervalRow.from_snapshot_id),
            toSnapshotId: Number(intervalRow.to_snapshot_id), endedAt: Number(intervalRow.ended_at),
            localDate: String(intervalRow.local_date), elapsedDays: Number(intervalRow.elapsed_days),
            status: String(intervalRow.status) as ProgressionIntervalRecord["status"], changes: rowCounters(intervalRow),
            tempoScore: intervalRow.tempo_score == null ? null : Number(intervalRow.tempo_score),
            formScore: intervalRow.form_score == null ? null : Number(intervalRow.form_score),
            scoreSampleN: intervalRow.score_sample_n == null ? null : Number(intervalRow.score_sample_n),
            confidence: Number(intervalRow.confidence), scoreVersion: Number(intervalRow.score_version),
          };
      }
      return {
        inserted: true,
        status: interval ? (interval.status === "valid" ? "progression" : interval.status) : "baseline",
        snapshot,
        interval,
      } as CaptureSnapshotResult;
    },

    async latestSnapshot(identity) {
      const row = await db.prepare(`SELECT * FROM progression_snapshots WHERE ${IDENTITY} ORDER BY profile_updated_at DESC LIMIT 1`)
        .bind(identity.mode, identity.cycleId, identity.aid).first() as Record<string, unknown> | null;
      return toSnapshot(row ?? undefined);
    },

    async snapshotHistory(identity) {
      const result = await db.prepare(`SELECT * FROM progression_snapshots WHERE ${IDENTITY} ORDER BY profile_updated_at`)
        .bind(identity.mode, identity.cycleId, identity.aid).all();
      return d1Rows(result).map((row) => toSnapshot(row)!).filter(Boolean);
    },

    async enqueueTask({ kind, priority, previousProfileUpdatedAt = null, availableAt, now = Date.now(), ...identity }) {
      validateTaskIdentity(identity);
      validateTaskKind(kind);
      validateTaskPriority(priority);
      const readyAt = availableAt ?? now;
      if (!Number.isFinite(readyAt)) throw new Error("invalid task availableAt");
      if (previousProfileUpdatedAt != null && !Number.isFinite(previousProfileUpdatedAt)) throw new Error("invalid previousProfileUpdatedAt");
      await db.prepare(`INSERT INTO scan_tasks (
        mode, cycle_id, aid, kind, priority, state, previous_profile_updated_at, available_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
      ON CONFLICT(mode, cycle_id, aid, kind) DO UPDATE SET
        priority = MIN(scan_tasks.priority, excluded.priority),
        previous_profile_updated_at = COALESCE(excluded.previous_profile_updated_at, scan_tasks.previous_profile_updated_at),
        available_at = MIN(scan_tasks.available_at, excluded.available_at),
        state = CASE WHEN scan_tasks.state IN ('queued', 'leased') THEN scan_tasks.state ELSE 'queued' END,
        lease_owner = CASE WHEN scan_tasks.state = 'leased' THEN scan_tasks.lease_owner ELSE NULL END,
        leased_until = CASE WHEN scan_tasks.state = 'leased' THEN scan_tasks.leased_until ELSE NULL END,
        consecutive_errors = CASE WHEN scan_tasks.state IN ('queued', 'leased') THEN scan_tasks.consecutive_errors ELSE 0 END,
        updated_at = excluded.updated_at`).bind(identity.mode, identity.cycleId, identity.aid, kind, priority,
        previousProfileUpdatedAt, readyAt, now, now).run();
      const row = await db.prepare("SELECT * FROM scan_tasks WHERE mode = ? AND cycle_id = ? AND aid = ? AND kind = ?")
        .bind(identity.mode, identity.cycleId, identity.aid, kind).first() as Record<string, unknown> | null;
      if (!row) throw new Error("Seasonal task upsert failed");
      return toScanTask(row);
    },

    async claimTasks({ mode, cycleId, actor, owner, limit, now = Date.now() }) {
      validateTaskIdentity({ mode, cycleId, aid: 1 });
      if (actor !== "helper" && actor !== "operator") throw new Error("invalid task actor");
      if (!owner.trim()) throw new Error("task lease owner is required");
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid task claim limit");
      const kindSql = actor === "operator" ? "IN ('profile', 'linked_pvp', 'ban_check')" : "IN ('profile', 'linked_pvp')";
      const selected = await db.prepare(`SELECT id FROM scan_tasks
        WHERE mode = ? AND cycle_id = ? AND available_at <= ? AND kind ${kindSql}
          AND (state = 'queued' OR (state = 'leased' AND leased_until <= ?))
        ORDER BY priority, available_at, created_at, id LIMIT ?`).bind(mode, cycleId, now, now, limit).all();
      const ids = d1Rows(selected).map((row) => Number(row.id));
      if (!ids.length) return [];
      const leasedUntil = now + 5 * 60_000;
      const updates = ids.map((id) => db.prepare(`UPDATE scan_tasks SET state = 'leased', lease_owner = ?, leased_until = ?,
        attempts = attempts + 1, updated_at = ? WHERE id = ?
        AND (state = 'queued' OR (state = 'leased' AND leased_until <= ?))`).bind(owner, leasedUntil, now, id, now));
      const updateResults = await db.batch(updates);
      const claimedIds = ids.filter((_, index) => d1Changes(updateResults[index]) === 1);
      if (!claimedIds.length) return [];
      const reads = await db.batch(claimedIds.map((id) => db.prepare("SELECT * FROM scan_tasks WHERE id = ?").bind(id)));
      return reads.flatMap((result: { results?: unknown[] }) => d1Rows(result).map(toScanTask)) as ScanTaskRecord[];
    },
  };
}
