/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-ignore -- Node's strip-types tests require explicit extensions; Next accepts them.
import type { CaptureSnapshotResult, ScanTaskPriority, SeasonalProfile, SeasonCycle } from "../../types/seasonal.ts";
// @ts-ignore -- Node's strip-types tests require explicit extensions; Next accepts them.
import type { D1DatabaseLike } from "./d1.ts";
// @ts-ignore -- Node's strip-types tests require explicit extensions; Next accepts them.
import { d1Changes, d1Rows } from "./d1.ts";
// @ts-ignore -- Node's strip-types tests require explicit extensions; Next accepts them.
import { allocateSeasonalPanelForAge, SEASONAL_PANEL_SIZE } from "./scanner.ts";

function reportingDate(timestamp: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function taskStatement(db: D1DatabaseLike, input: { cycleId: string; aid: number; kind: "profile" | "linked_pvp";
  priority: ScanTaskPriority; previousProfileUpdatedAt?: number | null; now: number }) {
  return db.prepare(`INSERT INTO scan_tasks (
    mode, cycle_id, aid, kind, priority, state, previous_profile_updated_at, available_at, created_at, updated_at
  ) VALUES ('seasonal', ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
  ON CONFLICT(mode, cycle_id, aid, kind) DO UPDATE SET
    priority = MIN(scan_tasks.priority, excluded.priority),
    previous_profile_updated_at = COALESCE(excluded.previous_profile_updated_at, scan_tasks.previous_profile_updated_at),
    available_at = MIN(scan_tasks.available_at, excluded.available_at),
    state = CASE WHEN scan_tasks.state IN ('queued', 'leased') THEN scan_tasks.state ELSE 'queued' END,
    lease_owner = CASE WHEN scan_tasks.state = 'leased' THEN scan_tasks.lease_owner ELSE NULL END,
    leased_until = CASE WHEN scan_tasks.state = 'leased' THEN scan_tasks.leased_until ELSE NULL END,
    updated_at = excluded.updated_at`).bind(input.cycleId, input.aid, input.kind, input.priority,
    input.previousProfileUpdatedAt ?? null, input.now, input.now, input.now);
}

export function createD1ScannerLifecycle(db: D1DatabaseLike) {
  const rebuildPanel = async (cycle: SeasonCycle, now: number) => {
    await db.prepare(`INSERT OR IGNORE INTO scan_cohorts
      (mode, cycle_id, name, target_size, created_at) VALUES ('seasonal', ?, 'initial-panel', ?, ?)`)
      .bind(cycle.cycleId, SEASONAL_PANEL_SIZE, now).run();
    const populationResult = await db.prepare(`SELECT CASE WHEN lifetime_pvp_hours < 50 THEN 0
      WHEN lifetime_pvp_hours < 100 THEN 1 WHEN lifetime_pvp_hours < 200 THEN 2
      WHEN lifetime_pvp_hours < 500 THEN 3 WHEN lifetime_pvp_hours < 1000 THEN 4
      WHEN lifetime_pvp_hours < 2000 THEN 5 WHEN lifetime_pvp_hours < 5000 THEN 6 ELSE 7 END AS band,
      COUNT(*) AS n FROM player_profiles WHERE mode = 'seasonal' AND cycle_id = ?
      AND confirmed_banned = 0 AND lifetime_pvp_hours IS NOT NULL GROUP BY band`).bind(cycle.cycleId).all();
    const population = d1Rows(populationResult).reduce((counts, row) => {
      counts[Number(row.band)] = Number(row.n); return counts;
    }, Array(8).fill(0) as number[]);
    const targets = allocateSeasonalPanelForAge(population, Math.max(0, now - cycle.startsAt));
    const cohort = await db.prepare(`SELECT id FROM scan_cohorts WHERE mode = 'seasonal'
      AND cycle_id = ? AND name = 'initial-panel'`).bind(cycle.cycleId).first() as { id: number } | null;
    if (!cohort) throw new Error("Seasonal cohort unavailable");
    for (let band = 0; band < 8; band += 1) {
      const count = await db.prepare(`SELECT COUNT(*) AS n FROM scan_members
        WHERE mode = 'seasonal' AND cycle_id = ? AND active = 1 AND lifetime_band = ?`)
        .bind(cycle.cycleId, band).first() as { n: number } | null;
      let current = Number(count?.n ?? 0);
      if (current > targets[band]) {
        await db.prepare(`UPDATE scan_members SET active = 0 WHERE rowid IN (
          SELECT rowid FROM scan_members WHERE mode = 'seasonal' AND cycle_id = ?
          AND active = 1 AND lifetime_band = ? ORDER BY joined_at DESC, aid DESC LIMIT ?)`)
          .bind(cycle.cycleId, band, current - targets[band]).run();
        current = targets[band];
      }
      const needed = Math.max(0, targets[band] - current);
      if (!needed) continue;
      const candidates = await db.prepare(`SELECT p.aid FROM player_profiles p LEFT JOIN scan_members m
        ON m.mode = p.mode AND m.cycle_id = p.cycle_id AND m.aid = p.aid
        WHERE p.mode = 'seasonal' AND p.cycle_id = ? AND p.confirmed_banned = 0
        AND p.lifetime_pvp_hours IS NOT NULL AND (m.aid IS NULL OR m.active = 0)
        AND (CASE WHEN p.lifetime_pvp_hours < 50 THEN 0 WHEN p.lifetime_pvp_hours < 100 THEN 1
          WHEN p.lifetime_pvp_hours < 200 THEN 2 WHEN p.lifetime_pvp_hours < 500 THEN 3
          WHEN p.lifetime_pvp_hours < 1000 THEN 4 WHEN p.lifetime_pvp_hours < 2000 THEN 5
          WHEN p.lifetime_pvp_hours < 5000 THEN 6 ELSE 7 END) = ?
        ORDER BY p.first_seen_at, p.aid LIMIT ?`).bind(cycle.cycleId, band, needed).all();
      const statements = d1Rows(candidates).map((candidate) => db.prepare(`INSERT INTO scan_members
        (mode, cycle_id, aid, cohort_id, lifetime_band, joined_at, active)
        VALUES ('seasonal', ?, ?, ?, ?, ?, 1) ON CONFLICT(mode, cycle_id, aid) DO UPDATE SET
        cohort_id = excluded.cohort_id, lifetime_band = excluded.lifetime_band,
        joined_at = excluded.joined_at, active = 1`).bind(cycle.cycleId, Number(candidate.aid),
        Number(cohort.id), band, now));
      if (statements.length) await db.batch(statements);
    }
  };

  return {
    async discoveryState(cycleId: string) {
      return await db.prepare(`SELECT cursor_key, cursor_aid, exhausted FROM scan_discovery_state
        WHERE mode = 'seasonal' AND cycle_id = ?`).bind(cycleId).first() as
        | { cursor_key: number; cursor_aid: number; exhausted: number } | null;
    },
    async advanceDiscovery(cycleId: string, next: { orderKey: number; aid: number } | null, now: number) {
      await db.prepare(`INSERT INTO scan_discovery_state
        (mode, cycle_id, cursor_key, cursor_aid, exhausted, updated_at)
        VALUES ('seasonal', ?, ?, ?, ?, ?) ON CONFLICT(mode, cycle_id) DO UPDATE SET
        cursor_key = excluded.cursor_key, cursor_aid = excluded.cursor_aid,
        exhausted = excluded.exhausted, updated_at = excluded.updated_at`)
        .bind(cycleId, next?.orderKey ?? -1, next?.aid ?? 0, next ? 0 : 1, now).run();
    },
    async recordCandidate(input: { cycleId: string; aid: number; nickname: string; trustedHours: number | null; now: number }) {
      await db.prepare(`INSERT INTO scan_candidates
        (mode, cycle_id, aid, nickname, lifetime_pvp_hours, lifetime_source, discovered_at, updated_at)
        VALUES ('seasonal', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(mode, cycle_id, aid) DO UPDATE SET
        nickname = excluded.nickname,
        lifetime_pvp_hours = COALESCE(scan_candidates.lifetime_pvp_hours, excluded.lifetime_pvp_hours),
        lifetime_source = COALESCE(scan_candidates.lifetime_source, excluded.lifetime_source), updated_at = excluded.updated_at`)
        .bind(input.cycleId, input.aid, input.nickname, input.trustedHours,
          input.trustedHours == null ? null : "public_cache", input.now, input.now).run();
      const profile = await db.prepare(`SELECT confirmed_banned FROM player_profiles
        WHERE mode = 'seasonal' AND cycle_id = ? AND aid = ?`).bind(input.cycleId, input.aid).first() as
        | { confirmed_banned: number } | null;
      if (Number(profile?.confirmed_banned ?? 0) !== 1) await taskStatement(db, { cycleId: input.cycleId,
        aid: input.aid, kind: input.trustedHours == null ? "linked_pvp" : "profile", priority: 4, now: input.now }).run();
    },
    async recordLinkedPvp(cycle: SeasonCycle, aid: number, enrichment: number | { hours: number; achievementIds?: string[]; profileUpdatedAt?: number | null }, now: number) {
      const normalized = typeof enrichment === "number" ? { hours: enrichment } : enrichment;
      const hours = normalized.hours;
      if (!Number.isFinite(hours) || hours < 0) throw new Error("invalid trusted PvP hours");
      const ids = [...new Set((normalized.achievementIds ?? []).filter((id) => typeof id === "string"))];
      const achievementIds = JSON.stringify(ids);
      const achievementCount = ids.length;
      const profileUpdatedAt = normalized.profileUpdatedAt ?? null;
      const enrichmentReady = profileUpdatedAt == null
        ? "(linked_pvp_profile_updated_at IS NULL AND lifetime_pvp_hours IS NULL)"
        : "(linked_pvp_profile_updated_at IS NULL OR linked_pvp_profile_updated_at <= ?)";
      const versionParams = profileUpdatedAt == null ? [] : [profileUpdatedAt];
      await db.batch([
        db.prepare(`INSERT INTO scan_candidates
          (mode, cycle_id, aid, lifetime_pvp_hours, lifetime_source, discovered_at, updated_at)
          VALUES ('seasonal', ?, ?, ?, 'linked_pvp', ?, ?) ON CONFLICT(mode, cycle_id, aid) DO UPDATE SET
          lifetime_pvp_hours = COALESCE(scan_candidates.lifetime_pvp_hours, excluded.lifetime_pvp_hours),
          lifetime_source = COALESCE(scan_candidates.lifetime_source, excluded.lifetime_source), updated_at = excluded.updated_at`)
          .bind(cycle.cycleId, aid, hours, now, now),
        db.prepare(`UPDATE player_profiles SET
          lifetime_pvp_hours = CASE
            WHEN ${enrichmentReady} THEN ? ELSE lifetime_pvp_hours END,
          linked_pvp_achievements = CASE
            WHEN ${enrichmentReady} THEN ? ELSE linked_pvp_achievements END,
          linked_pvp_achievement_count = CASE
            WHEN ${enrichmentReady} THEN ? ELSE linked_pvp_achievement_count END,
          linked_pvp_profile_updated_at = CASE
            WHEN ${enrichmentReady} THEN ? ELSE linked_pvp_profile_updated_at END
          WHERE mode = 'seasonal' AND cycle_id = ? AND aid = ? AND confirmed_banned = 0`)
          .bind(...versionParams, hours, ...versionParams, achievementIds,
            ...versionParams, achievementCount, ...versionParams, profileUpdatedAt,
            cycle.cycleId, aid),
      ]);
      await rebuildPanel(cycle, now);
    },
    async recordCapture(cycle: SeasonCycle, profile: SeasonalProfile, capture: CaptureSnapshotResult, trustedHours: number | null, now: number) {
      const statements = [
        db.prepare(`INSERT INTO scan_candidates
          (mode, cycle_id, aid, nickname, lifetime_pvp_hours, lifetime_source, discovered_at, updated_at)
          VALUES ('seasonal', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(mode, cycle_id, aid) DO UPDATE SET
          nickname = excluded.nickname,
          lifetime_pvp_hours = COALESCE(scan_candidates.lifetime_pvp_hours, excluded.lifetime_pvp_hours),
          lifetime_source = COALESCE(scan_candidates.lifetime_source, excluded.lifetime_source), updated_at = excluded.updated_at`)
          .bind(cycle.cycleId, profile.aid, profile.nickname, trustedHours,
            trustedHours == null ? null : "public_cache", now, now),
        db.prepare(`UPDATE player_profiles SET lifetime_pvp_hours = COALESCE(lifetime_pvp_hours,
          (SELECT lifetime_pvp_hours FROM scan_candidates c WHERE c.mode = player_profiles.mode
            AND c.cycle_id = player_profiles.cycle_id AND c.aid = player_profiles.aid))
          WHERE mode = 'seasonal' AND cycle_id = ? AND aid = ?`).bind(cycle.cycleId, profile.aid),
      ];
      if (capture.inserted) statements.push(db.prepare(`UPDATE player_profiles SET progression_eligible =
        CASE WHEN (
          SELECT COUNT(*) FROM progression_intervals interval
          WHERE interval.mode = player_profiles.mode AND interval.cycle_id = player_profiles.cycle_id
            AND interval.aid = player_profiles.aid AND interval.status = 'valid' AND interval.pmc_raids > 0
        ) >= 2 THEN 1 ELSE 0 END
        WHERE mode = 'seasonal' AND cycle_id = ? AND aid = ? AND confirmed_banned = 0`).bind(cycle.cycleId, profile.aid));
      await db.batch(statements);
      await rebuildPanel(cycle, now);
    },
    async finalizeTask(cycle: SeasonCycle, taskId: number, now: number) {
      const task = await db.prepare(`SELECT aid, kind, previous_profile_updated_at FROM scan_tasks WHERE id = ? AND mode = 'seasonal'
        AND cycle_id = ? AND state = 'completed'`).bind(taskId, cycle.cycleId).first() as
        | { aid: number; kind: "profile" | "linked_pvp" | "ban_check"; previous_profile_updated_at: number | null } | null;
      if (!task || task.kind === "ban_check") return;
      const profile = await db.prepare(`SELECT profile_updated_at, snapshot_count, confirmed_banned FROM player_profiles
        WHERE mode = 'seasonal' AND cycle_id = ? AND aid = ?`).bind(cycle.cycleId, task.aid).first() as
        | { profile_updated_at: number; snapshot_count: number; confirmed_banned: number } | null;
      if (Number(profile?.confirmed_banned ?? 0) === 1) return;
      if (task.kind === "linked_pvp") await taskStatement(db, { cycleId: cycle.cycleId, aid: task.aid,
        kind: "profile", priority: profile?.snapshot_count ? 3 : 4,
        previousProfileUpdatedAt: profile?.profile_updated_at ?? null, now }).run();
      else if (Number(profile?.snapshot_count ?? 0) === 1 && (task.previous_profile_updated_at == null ||
        Number(profile!.profile_updated_at) > Number(task.previous_profile_updated_at))) await taskStatement(db, { cycleId: cycle.cycleId,
        aid: task.aid, kind: "profile", priority: 3, previousProfileUpdatedAt: Number(profile!.profile_updated_at), now }).run();
    },
    async enqueueAfterProfileOpen(cycle: SeasonCycle, aid: number, now: number) {
      const profile = await db.prepare(`SELECT profile_updated_at, snapshot_count, lifetime_pvp_hours, confirmed_banned
        FROM player_profiles WHERE mode = 'seasonal' AND cycle_id = ? AND aid = ?`).bind(cycle.cycleId, aid).first() as
        Record<string, unknown> | null;
      if (!profile || Number(profile.confirmed_banned) === 1) return;
      if (profile.lifetime_pvp_hours == null) await taskStatement(db, { cycleId: cycle.cycleId, aid,
        kind: "linked_pvp", priority: 3, now }).run();
      else if (Number(profile.snapshot_count) === 1) await taskStatement(db, { cycleId: cycle.cycleId, aid,
        kind: "profile", priority: 3, previousProfileUpdatedAt: Number(profile.profile_updated_at), now }).run();
    },
    async requeueDaily(cycle: SeasonCycle, now: number) {
      const date = reportingDate(now);
      const existing = await db.prepare(`SELECT 1 FROM scan_daily_requeues
        WHERE mode = 'seasonal' AND cycle_id = ? AND local_date = ?`).bind(cycle.cycleId, date).first();
      if (existing) return false;
      const profiles = await db.prepare(`SELECT p.aid, p.profile_updated_at, p.snapshot_count,
        p.lifetime_pvp_hours, CASE WHEN m.aid IS NULL THEN 0 ELSE 1 END AS panel
        FROM player_profiles p LEFT JOIN scan_members m
          ON m.mode = p.mode AND m.cycle_id = p.cycle_id AND m.aid = p.aid AND m.active = 1
        LEFT JOIN progression_snapshots s ON s.mode = p.mode AND s.cycle_id = p.cycle_id
          AND s.aid = p.aid AND s.profile_updated_at = p.profile_updated_at
        WHERE p.mode = 'seasonal' AND p.cycle_id = ? AND p.confirmed_banned = 0
          AND (s.local_date IS NULL OR s.local_date < ?)`).bind(cycle.cycleId, date).all();
      const candidates = await db.prepare(`SELECT c.aid, c.lifetime_pvp_hours FROM scan_candidates c
        LEFT JOIN player_profiles p ON p.mode = c.mode AND p.cycle_id = c.cycle_id AND p.aid = c.aid
        WHERE c.mode = 'seasonal' AND c.cycle_id = ? AND p.aid IS NULL`).bind(cycle.cycleId).all();
      const tasks = d1Rows(profiles).map((row) => {
        const kind = row.lifetime_pvp_hours == null ? "linked_pvp" as const : "profile" as const;
        const priority = (Number(row.panel) === 1 ? 1 : Number(row.snapshot_count) >= 2 ? 2 : 3) as ScanTaskPriority;
        return taskStatement(db, { cycleId: cycle.cycleId, aid: Number(row.aid), kind, priority,
          previousProfileUpdatedAt: kind === "profile" ? Number(row.profile_updated_at) : null, now });
      });
      tasks.push(...d1Rows(candidates).map((row) => taskStatement(db, { cycleId: cycle.cycleId,
        aid: Number(row.aid), kind: row.lifetime_pvp_hours == null ? "linked_pvp" : "profile", priority: 4, now })));
      for (let index = 0; index < tasks.length; index += 250) await db.batch(tasks.slice(index, index + 250));
      const marker = await db.prepare(`INSERT OR IGNORE INTO scan_daily_requeues
        (mode, cycle_id, local_date, created_at) VALUES ('seasonal', ?, ?, ?)`).bind(cycle.cycleId, date, now).run();
      await rebuildPanel(cycle, now);
      return d1Changes(marker) === 1;
    },
    async queuedNewCandidates(cycleId: string) {
      const row = await db.prepare(`SELECT COUNT(*) AS n FROM scan_tasks WHERE mode = 'seasonal'
        AND cycle_id = ? AND priority = 4 AND state IN ('queued', 'leased')`).bind(cycleId).first() as { n: number } | null;
      return Number(row?.n ?? 0);
    },
  };
}
