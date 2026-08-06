export const SEASONAL_PANEL_SIZE = 2_000;
export const SEASONAL_PANEL_MINIMUM_PER_BAND = 150;
export const SEASONAL_PANEL_BUILD_WINDOW_MS = 72 * 60 * 60_000;
const LIFETIME_BAND_COUNT = 8;

export function seasonalCandidateOrderParameters(cycleId: string): { multiplier: number; offset: number } {
  let hash = 2166136261;
  for (const char of cycleId) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return { multiplier: ((hash % 1_000_000) | 1), offset: (hash >>> 1) & 0x7fffffff };
}

export function seasonalCandidateOrderKey(cycleId: string, aid: number): number {
  const { multiplier, offset } = seasonalCandidateOrderParameters(cycleId);
  return Number((BigInt(aid) * BigInt(multiplier) + BigInt(offset)) & BigInt(2147483647));
}

/** Fixed eight-band allocation for the initial Seasonal longitudinal panel. */
export function allocateSeasonalPanel(populationByBand: readonly number[]): number[] {
  return allocatePanel(populationByBand, true);
}

/** Before 72h, unavailable minimum seats stay reserved; afterwards they move. */
export function allocateSeasonalPanelForAge(
  populationByBand: readonly number[],
  cycleAgeMs: number,
): number[] {
  return allocatePanel(populationByBand, cycleAgeMs >= SEASONAL_PANEL_BUILD_WINDOW_MS);
}

function allocatePanel(populationByBand: readonly number[], redistributeMissingMinimums: boolean): number[] {
  if (populationByBand.length !== LIFETIME_BAND_COUNT) {
    throw new Error("population must contain all eight lifetime-hour bands");
  }
  const population = populationByBand.map((value) => {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid band population");
    return value;
  });
  const allocation = population.map((value) => Math.min(value, SEASONAL_PANEL_MINIMUM_PER_BAND));
  const base = allocation.reduce((sum, value) => sum + value, 0);
  const target = redistributeMissingMinimums
    ? Math.min(SEASONAL_PANEL_SIZE, population.reduce((sum, value) => sum + value, 0))
    : Math.min(base + (SEASONAL_PANEL_SIZE - LIFETIME_BAND_COUNT * SEASONAL_PANEL_MINIMUM_PER_BAND),
      population.reduce((sum, value) => sum + value, 0));
  let remaining = target - base;

  while (remaining > 0) {
    const eligible = population.map((value, index) => value > allocation[index] ? index : -1)
      .filter((index) => index >= 0);
    if (eligible.length === 0) break;
    const weightTotal = eligible.reduce((sum, index) => sum + population[index], 0);
    const shares = eligible.map((index) => ({
      index,
      exact: remaining * population[index] / weightTotal,
    }));
    let granted = 0;
    for (const share of shares) {
      const seats = Math.min(population[share.index] - allocation[share.index], Math.floor(share.exact));
      allocation[share.index] += seats;
      granted += seats;
    }
    remaining -= granted;
    if (remaining === 0) break;

    shares.sort((a, b) => (b.exact % 1) - (a.exact % 1) || a.index - b.index);
    let remainderGranted = 0;
    for (const { index } of shares) {
      if (remaining === 0) break;
      if (allocation[index] < population[index]) {
        allocation[index] += 1;
        remaining -= 1;
        remainderGranted += 1;
      }
    }
    if (granted === 0 && remainderGranted === 0) break;
  }

  return allocation;
}

// Scanner lifecycle uses concrete SQLite and D1 stores behind these narrow
// orchestration hooks; no general backend/plugin abstraction is needed.
import type { CaptureSnapshotResult, ScanTaskPriority, SeasonalProfile, SeasonCycle } from "@/types/seasonal";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SqliteDatabase = any;

const LIFECYCLE_SCHEMA = `
CREATE TABLE IF NOT EXISTS scan_candidates (
  mode TEXT NOT NULL CHECK (mode = 'seasonal'), cycle_id TEXT NOT NULL, aid INTEGER NOT NULL,
  nickname TEXT, lifetime_pvp_hours REAL, lifetime_source TEXT,
  discovered_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (mode, cycle_id, aid)
);
CREATE TABLE IF NOT EXISTS scan_discovery_state (
  mode TEXT NOT NULL CHECK (mode = 'seasonal'), cycle_id TEXT NOT NULL,
  cursor_key INTEGER NOT NULL DEFAULT -1, cursor_aid INTEGER NOT NULL DEFAULT 0,
  exhausted INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
  PRIMARY KEY (mode, cycle_id)
);
CREATE TABLE IF NOT EXISTS scan_daily_requeues (
  mode TEXT NOT NULL CHECK (mode = 'seasonal'), cycle_id TEXT NOT NULL,
  local_date TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (mode, cycle_id, local_date)
);`;

function tableColumns(db: SqliteDatabase, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((row) => row.name));
}

export function initializeSqliteScannerLifecycle(db: SqliteDatabase): void {
  db.exec(LIFECYCLE_SCHEMA);
  if (!tableColumns(db, "player_profiles").size) {
    throw new Error("Seasonal schema must be initialized before scanner lifecycle");
  }
  if (!tableColumns(db, "player_profiles").has("progression_eligible")) {
    db.exec("ALTER TABLE player_profiles ADD COLUMN progression_eligible INTEGER NOT NULL DEFAULT 0");
  }
  db.exec(`UPDATE player_profiles SET progression_eligible = CASE WHEN confirmed_banned = 0 AND (
    SELECT COUNT(*) FROM progression_intervals interval
    WHERE interval.mode = player_profiles.mode AND interval.cycle_id = player_profiles.cycle_id
      AND interval.aid = player_profiles.aid AND interval.status = 'valid' AND interval.pmc_raids > 0
  ) >= 2 THEN 1 ELSE 0 END WHERE mode = 'seasonal'`);
}

function enqueueSqliteTask(
  db: SqliteDatabase,
  input: { cycleId: string; aid: number; kind: "profile" | "linked_pvp"; priority: ScanTaskPriority;
    previousProfileUpdatedAt?: number | null; now: number },
): void {
  db.prepare(`INSERT INTO scan_tasks (
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
      updated_at = excluded.updated_at`)
    .run(input.cycleId, input.aid, input.kind, input.priority,
      input.previousProfileUpdatedAt ?? null, input.now, input.now, input.now);
}

export function createSqliteScannerLifecycle(db: SqliteDatabase) {
  initializeSqliteScannerLifecycle(db);

  const rebuildPanel = (cycle: SeasonCycle, now: number) => {
    db.prepare(`INSERT OR IGNORE INTO scan_cohorts
      (mode, cycle_id, name, target_size, created_at) VALUES ('seasonal', ?, 'initial-panel', ?, ?)`)
      .run(cycle.cycleId, SEASONAL_PANEL_SIZE, now);
    const population = (db.prepare(`SELECT
      CASE WHEN lifetime_pvp_hours < 50 THEN 0 WHEN lifetime_pvp_hours < 100 THEN 1
        WHEN lifetime_pvp_hours < 200 THEN 2 WHEN lifetime_pvp_hours < 500 THEN 3
        WHEN lifetime_pvp_hours < 1000 THEN 4 WHEN lifetime_pvp_hours < 2000 THEN 5
        WHEN lifetime_pvp_hours < 5000 THEN 6 ELSE 7 END AS band, COUNT(*) AS n
      FROM player_profiles WHERE mode = 'seasonal' AND cycle_id = ?
        AND confirmed_banned = 0 AND lifetime_pvp_hours IS NOT NULL GROUP BY band`)
      .all(cycle.cycleId) as { band: number; n: number }[])
      .reduce((counts, row) => { counts[Number(row.band)] = Number(row.n); return counts; }, Array(8).fill(0) as number[]);
    const targets = allocateSeasonalPanelForAge(population, Math.max(0, now - cycle.startsAt));
    const cohort = db.prepare(`SELECT id FROM scan_cohorts WHERE mode = 'seasonal'
      AND cycle_id = ? AND name = 'initial-panel'`).get(cycle.cycleId) as { id: number };
    for (let band = 0; band < 8; band += 1) {
      let current = Number((db.prepare(`SELECT COUNT(*) AS n FROM scan_members
        WHERE mode = 'seasonal' AND cycle_id = ? AND active = 1 AND lifetime_band = ?`)
        .get(cycle.cycleId, band) as { n: number }).n);
      if (current > targets[band]) {
        const excess = current - targets[band];
        db.prepare(`UPDATE scan_members SET active = 0 WHERE rowid IN (
          SELECT rowid FROM scan_members WHERE mode = 'seasonal' AND cycle_id = ?
            AND active = 1 AND lifetime_band = ? ORDER BY joined_at DESC, aid DESC LIMIT ?
        )`).run(cycle.cycleId, band, excess);
        current = targets[band];
      }
      const needed = Math.max(0, targets[band] - current);
      if (!needed) continue;
      const candidates = db.prepare(`SELECT p.aid FROM player_profiles p
        LEFT JOIN scan_members m ON m.mode = p.mode AND m.cycle_id = p.cycle_id AND m.aid = p.aid
        WHERE p.mode = 'seasonal' AND p.cycle_id = ? AND p.confirmed_banned = 0
          AND p.lifetime_pvp_hours IS NOT NULL AND (m.aid IS NULL OR m.active = 0)
          AND (CASE WHEN p.lifetime_pvp_hours < 50 THEN 0 WHEN p.lifetime_pvp_hours < 100 THEN 1
            WHEN p.lifetime_pvp_hours < 200 THEN 2 WHEN p.lifetime_pvp_hours < 500 THEN 3
            WHEN p.lifetime_pvp_hours < 1000 THEN 4 WHEN p.lifetime_pvp_hours < 2000 THEN 5
            WHEN p.lifetime_pvp_hours < 5000 THEN 6 ELSE 7 END) = ?
        ORDER BY p.first_seen_at, p.aid LIMIT ?`).all(cycle.cycleId, band, needed) as { aid: number }[];
      for (const candidate of candidates) {
        db.prepare(`INSERT INTO scan_members
          (mode, cycle_id, aid, cohort_id, lifetime_band, joined_at, active)
          VALUES ('seasonal', ?, ?, ?, ?, ?, 1) ON CONFLICT(mode, cycle_id, aid) DO UPDATE SET
          cohort_id = excluded.cohort_id, lifetime_band = excluded.lifetime_band,
          joined_at = excluded.joined_at, active = 1`)
          .run(cycle.cycleId, Number(candidate.aid), Number(cohort.id), band, now);
      }
    }
  };

  return {
    discoveryState(cycleId: string) {
      return db.prepare(`SELECT cursor_key, cursor_aid, exhausted FROM scan_discovery_state
        WHERE mode = 'seasonal' AND cycle_id = ?`).get(cycleId) as
        | { cursor_key: number; cursor_aid: number; exhausted: number }
        | undefined;
    },
    advanceDiscovery(cycleId: string, next: { orderKey: number; aid: number } | null, now: number) {
      db.prepare(`INSERT INTO scan_discovery_state
        (mode, cycle_id, cursor_key, cursor_aid, exhausted, updated_at)
        VALUES ('seasonal', ?, ?, ?, ?, ?) ON CONFLICT(mode, cycle_id) DO UPDATE SET
        cursor_key = excluded.cursor_key, cursor_aid = excluded.cursor_aid,
        exhausted = excluded.exhausted, updated_at = excluded.updated_at`)
        .run(cycleId, next?.orderKey ?? -1, next?.aid ?? 0, next ? 0 : 1, now);
    },
    recordCandidate(input: { cycleId: string; aid: number; nickname: string; trustedHours: number | null; now: number }) {
      db.prepare(`INSERT INTO scan_candidates
        (mode, cycle_id, aid, nickname, lifetime_pvp_hours, lifetime_source, discovered_at, updated_at)
        VALUES ('seasonal', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(mode, cycle_id, aid) DO UPDATE SET
        nickname = excluded.nickname,
        lifetime_pvp_hours = COALESCE(scan_candidates.lifetime_pvp_hours, excluded.lifetime_pvp_hours),
        lifetime_source = COALESCE(scan_candidates.lifetime_source, excluded.lifetime_source),
        updated_at = excluded.updated_at`)
        .run(input.cycleId, input.aid, input.nickname, input.trustedHours,
          input.trustedHours == null ? null : "public_cache", input.now, input.now);
      const banned = db.prepare(`SELECT confirmed_banned FROM player_profiles
        WHERE mode = 'seasonal' AND cycle_id = ? AND aid = ?`).get(input.cycleId, input.aid) as
        | { confirmed_banned: number }
        | undefined;
      if (Number(banned?.confirmed_banned ?? 0) === 1) return;
      enqueueSqliteTask(db, {
        cycleId: input.cycleId, aid: input.aid,
        kind: input.trustedHours == null ? "linked_pvp" : "profile", priority: 4, now: input.now,
      });
    },
    recordLinkedPvp(cycle: SeasonCycle, aid: number, enrichment: number | { hours: number; achievementIds?: string[]; profileUpdatedAt?: number | null }, now: number) {
      const normalized = typeof enrichment === "number" ? { hours: enrichment } : enrichment;
      const hours = normalized.hours;
      if (!Number.isFinite(hours) || hours < 0) throw new Error("invalid trusted PvP hours");
      const ids = [...new Set((normalized.achievementIds ?? []).filter((id) => typeof id === "string"))];
      const achievementIds = JSON.stringify(ids);
      const achievementCount = ids.length;
      db.prepare(`INSERT INTO scan_candidates
        (mode, cycle_id, aid, lifetime_pvp_hours, lifetime_source, discovered_at, updated_at)
        VALUES ('seasonal', ?, ?, ?, 'linked_pvp', ?, ?) ON CONFLICT(mode, cycle_id, aid) DO UPDATE SET
        lifetime_pvp_hours = COALESCE(scan_candidates.lifetime_pvp_hours, excluded.lifetime_pvp_hours),
        lifetime_source = COALESCE(scan_candidates.lifetime_source, excluded.lifetime_source),
        updated_at = excluded.updated_at`).run(cycle.cycleId, aid, hours, now, now);
      const profileUpdatedAt = normalized.profileUpdatedAt ?? null;
      db.prepare(`UPDATE player_profiles SET
          lifetime_pvp_hours = CASE
            WHEN ${normalized.profileUpdatedAt == null
              ? "(linked_pvp_profile_updated_at IS NULL AND lifetime_pvp_hours IS NULL)"
              : "(linked_pvp_profile_updated_at IS NULL OR linked_pvp_profile_updated_at <= ?)"}
              THEN ? ELSE lifetime_pvp_hours END,
          linked_pvp_achievements = CASE
            WHEN ${normalized.profileUpdatedAt == null
              ? "(linked_pvp_profile_updated_at IS NULL AND lifetime_pvp_hours IS NULL)"
              : "(linked_pvp_profile_updated_at IS NULL OR linked_pvp_profile_updated_at <= ?)"}
              THEN ? ELSE linked_pvp_achievements END,
          linked_pvp_achievement_count = CASE
            WHEN ${normalized.profileUpdatedAt == null
              ? "(linked_pvp_profile_updated_at IS NULL AND lifetime_pvp_hours IS NULL)"
              : "(linked_pvp_profile_updated_at IS NULL OR linked_pvp_profile_updated_at <= ?)"}
              THEN ? ELSE linked_pvp_achievement_count END,
          linked_pvp_profile_updated_at = CASE
            WHEN ${normalized.profileUpdatedAt == null
              ? "(linked_pvp_profile_updated_at IS NULL AND lifetime_pvp_hours IS NULL)"
              : "(linked_pvp_profile_updated_at IS NULL OR linked_pvp_profile_updated_at <= ?)"}
              THEN ? ELSE linked_pvp_profile_updated_at END
        WHERE mode = 'seasonal' AND cycle_id = ? AND aid = ? AND confirmed_banned = 0`)
        .run(...(profileUpdatedAt == null ? [] : [profileUpdatedAt]), hours,
          ...(profileUpdatedAt == null ? [] : [profileUpdatedAt]), achievementIds,
          ...(profileUpdatedAt == null ? [] : [profileUpdatedAt]), achievementCount,
          ...(profileUpdatedAt == null ? [] : [profileUpdatedAt]), profileUpdatedAt,
          cycle.cycleId, aid);
      rebuildPanel(cycle, now);
    },
    recordCapture(cycle: SeasonCycle, profile: SeasonalProfile, capture: CaptureSnapshotResult, trustedHours: number | null, now: number) {
      db.prepare(`INSERT INTO scan_candidates
        (mode, cycle_id, aid, nickname, lifetime_pvp_hours, lifetime_source, discovered_at, updated_at)
        VALUES ('seasonal', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(mode, cycle_id, aid) DO UPDATE SET
        nickname = excluded.nickname,
        lifetime_pvp_hours = COALESCE(scan_candidates.lifetime_pvp_hours, excluded.lifetime_pvp_hours),
        lifetime_source = COALESCE(scan_candidates.lifetime_source, excluded.lifetime_source),
        updated_at = excluded.updated_at`)
        .run(cycle.cycleId, profile.aid, profile.nickname, trustedHours,
          trustedHours == null ? null : "public_cache", now, now);
      db.prepare(`UPDATE player_profiles SET lifetime_pvp_hours = COALESCE(lifetime_pvp_hours,
        (SELECT lifetime_pvp_hours FROM scan_candidates c WHERE c.mode = player_profiles.mode
          AND c.cycle_id = player_profiles.cycle_id AND c.aid = player_profiles.aid))
        WHERE mode = 'seasonal' AND cycle_id = ? AND aid = ?`).run(cycle.cycleId, profile.aid);
      if (capture.inserted) {
        db.prepare(`UPDATE player_profiles SET progression_eligible = CASE WHEN (
          SELECT COUNT(*) FROM progression_intervals interval
          WHERE interval.mode = player_profiles.mode AND interval.cycle_id = player_profiles.cycle_id
            AND interval.aid = player_profiles.aid AND interval.status = 'valid' AND interval.pmc_raids > 0
        ) >= 2 THEN 1 ELSE 0 END
          WHERE mode = 'seasonal' AND cycle_id = ? AND aid = ? AND confirmed_banned = 0`)
          .run(cycle.cycleId, profile.aid);
      }
      rebuildPanel(cycle, now);
    },
    finalizeTask(cycle: SeasonCycle, taskId: number, now: number) {
      const task = db.prepare(`SELECT aid, kind, previous_profile_updated_at FROM scan_tasks WHERE id = ? AND mode = 'seasonal'
        AND cycle_id = ? AND state = 'completed'`).get(taskId, cycle.cycleId) as
        | { aid: number; kind: "profile" | "linked_pvp" | "ban_check"; previous_profile_updated_at: number | null }
        | undefined;
      if (!task || task.kind === "ban_check") return;
      const profile = db.prepare(`SELECT profile_updated_at, snapshot_count, confirmed_banned FROM player_profiles
        WHERE mode = 'seasonal' AND cycle_id = ? AND aid = ?`).get(cycle.cycleId, task.aid) as
        | { profile_updated_at: number; snapshot_count: number; confirmed_banned: number }
        | undefined;
      if (Number(profile?.confirmed_banned ?? 0) === 1) return;
      if (task.kind === "linked_pvp") {
        enqueueSqliteTask(db, { cycleId: cycle.cycleId, aid: task.aid, kind: "profile",
          priority: profile?.snapshot_count ? 3 : 4,
          previousProfileUpdatedAt: profile?.profile_updated_at ?? null, now });
      } else if (Number(profile?.snapshot_count ?? 0) === 1 && (
        task.previous_profile_updated_at == null ||
        Number(profile!.profile_updated_at) > Number(task.previous_profile_updated_at)
      )) {
        enqueueSqliteTask(db, { cycleId: cycle.cycleId, aid: task.aid, kind: "profile", priority: 3,
          previousProfileUpdatedAt: Number(profile!.profile_updated_at), now });
      }
    },
    enqueueAfterProfileOpen(cycle: SeasonCycle, aid: number, now: number) {
      const profile = db.prepare(`SELECT profile_updated_at, snapshot_count, lifetime_pvp_hours, confirmed_banned
        FROM player_profiles WHERE mode = 'seasonal' AND cycle_id = ? AND aid = ?`)
        .get(cycle.cycleId, aid) as Record<string, unknown> | undefined;
      if (!profile || Number(profile.confirmed_banned) === 1) return;
      if (profile.lifetime_pvp_hours == null) {
        enqueueSqliteTask(db, { cycleId: cycle.cycleId, aid, kind: "linked_pvp", priority: 3, now });
        return;
      }
      if (Number(profile.snapshot_count) === 1) {
        enqueueSqliteTask(db, { cycleId: cycle.cycleId, aid, kind: "profile", priority: 3,
          previousProfileUpdatedAt: Number(profile.profile_updated_at), now });
      }
    },
    requeueDaily(cycle: SeasonCycle, now: number) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const date = reportingDate(now);
        const marker = db.prepare(`INSERT OR IGNORE INTO scan_daily_requeues
          (mode, cycle_id, local_date, created_at) VALUES ('seasonal', ?, ?, ?)`)
          .run(cycle.cycleId, date, now);
        if (Number(marker.changes) !== 1) {
          db.exec("COMMIT");
          return false;
        }
        const rows = db.prepare(`SELECT p.aid, p.profile_updated_at, p.snapshot_count,
          p.lifetime_pvp_hours, CASE WHEN m.aid IS NULL THEN 0 ELSE 1 END AS panel
        FROM player_profiles p LEFT JOIN scan_members m
          ON m.mode = p.mode AND m.cycle_id = p.cycle_id AND m.aid = p.aid AND m.active = 1
        LEFT JOIN progression_snapshots s ON s.mode = p.mode AND s.cycle_id = p.cycle_id
          AND s.aid = p.aid AND s.profile_updated_at = p.profile_updated_at
        WHERE p.mode = 'seasonal' AND p.cycle_id = ? AND p.confirmed_banned = 0
          AND (s.local_date IS NULL OR s.local_date < ?)`)
        .all(cycle.cycleId, date) as Record<string, unknown>[];
        for (const row of rows) {
          const priority: ScanTaskPriority = Number(row.panel) === 1 ? 1 : Number(row.snapshot_count) >= 2 ? 2 : 3;
          const kind = row.lifetime_pvp_hours == null ? "linked_pvp" : "profile";
          enqueueSqliteTask(db, { cycleId: cycle.cycleId, aid: Number(row.aid), kind, priority,
            previousProfileUpdatedAt: kind === "profile" ? Number(row.profile_updated_at) : null, now });
        }
        const candidates = db.prepare(`SELECT c.aid, c.lifetime_pvp_hours FROM scan_candidates c
        LEFT JOIN player_profiles p ON p.mode = c.mode AND p.cycle_id = c.cycle_id AND p.aid = c.aid
        WHERE c.mode = 'seasonal' AND c.cycle_id = ? AND p.aid IS NULL`)
          .all(cycle.cycleId) as Record<string, unknown>[];
        for (const row of candidates) enqueueSqliteTask(db, { cycleId: cycle.cycleId, aid: Number(row.aid),
          kind: row.lifetime_pvp_hours == null ? "linked_pvp" : "profile", priority: 4, now });
        rebuildPanel(cycle, now);
        db.exec("COMMIT");
        return true;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    queuedNewCandidates(cycleId: string) {
      return Number((db.prepare(`SELECT COUNT(*) AS n FROM scan_tasks WHERE mode = 'seasonal'
        AND cycle_id = ? AND priority = 4 AND state IN ('queued', 'leased')`).get(cycleId) as { n: number }).n);
    },
  };
}

let lifecycleDb: SqliteDatabase | null = null;

function reportingDate(timestamp: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function getLifecycle(cycle: SeasonCycle) {
  const { getSeasonalD1 } = await import("./d1");
  const d1 = await getSeasonalD1();
  if (d1) {
    const { upsertD1SeasonCycle } = await import("./storage-d1");
    const { createD1ScannerLifecycle } = await import("./scanner-d1");
    await upsertD1SeasonCycle(d1, cycle);
    return createD1ScannerLifecycle(d1);
  }
  if (!lifecycleDb) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sqlite = (await import("node:sqlite" as string)) as any;
    lifecycleDb = new sqlite.DatabaseSync(
      process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db",
    );
    const { initializeSeasonalSchema } = await import("./storage");
    initializeSeasonalSchema(lifecycleDb);
  }
  const lifecycle = createSqliteScannerLifecycle(lifecycleDb);
  lifecycleDb.prepare(`INSERT INTO season_cycles (mode, cycle_id, starts_at, ends_at, enabled, upstream_contract)
    VALUES ('seasonal', ?, ?, ?, ?, ?) ON CONFLICT(mode, cycle_id) DO UPDATE SET
    starts_at = excluded.starts_at, ends_at = excluded.ends_at, enabled = excluded.enabled,
    upstream_contract = excluded.upstream_contract`)
    .run(cycle.cycleId, cycle.startsAt, cycle.endsAt, cycle.enabled ? 1 : 0, cycle.upstreamContract);
  return lifecycle;
}

export async function prepareSeasonalScannerCycle(cycle: SeasonCycle, now = Date.now()) {
  const lifecycle = await getLifecycle(cycle);
  await lifecycle.requeueDaily(cycle, now);
  const state = await lifecycle.discoveryState(cycle.cycleId);
  if (state?.exhausted || await lifecycle.queuedNewCandidates(cycle.cycleId) >= 100) {
    return { supported: true, discovered: 0 };
  }
  const { getDeterministicPlayerIndexPage } = await import("@/lib/db");
  const page = await getDeterministicPlayerIndexPage(cycle.cycleId,
    state ? { orderKey: Number(state.cursor_key), aid: Number(state.cursor_aid) } : null, 250);
  if (!page) return { supported: true, discovered: 0 };
  for (const player of page.players) await lifecycle.recordCandidate({
      cycleId: cycle.cycleId, aid: player.aid, nickname: player.name,
      trustedHours: player.trustedHours, now,
    });
  await lifecycle.advanceDiscovery(cycle.cycleId, page.nextCursor, now);
  return { supported: true, discovered: page.players.length };
}

export async function recordSeasonalCaptureLifecycle(
  cycle: SeasonCycle,
  profile: SeasonalProfile,
  capture: CaptureSnapshotResult,
  source: "profile_open" | "task",
  now = Date.now(),
) {
  const lifecycle = await getLifecycle(cycle);
  const { getTrustedPublicHours } = await import("@/lib/db");
  const trustedHours = await getTrustedPublicHours(profile.aid);
  await lifecycle.recordCapture(cycle, profile, capture, trustedHours, now);
  if (source === "profile_open") await lifecycle.enqueueAfterProfileOpen(cycle, profile.aid, now);
  return { supported: true };
}

export async function recordLinkedPvpLifecycle(
  cycle: SeasonCycle,
  aid: number,
  enrichment: number | { hours: number; achievementIds?: string[]; profileUpdatedAt?: number | null },
  now = Date.now(),
) {
  const lifecycle = await getLifecycle(cycle);
  await lifecycle.recordLinkedPvp(cycle, aid, enrichment, now);
  return { supported: true };
}

export async function finalizeSeasonalTaskLifecycle(cycle: SeasonCycle, taskId: number, now = Date.now()) {
  const lifecycle = await getLifecycle(cycle);
  await lifecycle.finalizeTask(cycle, taskId, now);
  return { supported: true };
}
