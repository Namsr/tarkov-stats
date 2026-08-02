// @ts-expect-error Node's strip-types test runner requires the extension; Next accepts it.
import { refreshSqliteProgressionAggregates } from "./seasonal/daily-aggregates.ts";
// @ts-expect-error Node's strip-types test runner requires the extension; Next accepts it.
import { initializeSeasonalSchema } from "./seasonal/storage.ts";
// @ts-expect-error Node's strip-types test runner requires the extension; Next accepts it.
import { isRaidProgressionInterval } from "./seasonal/analytics.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SqliteDatabase = any;
type Counters = Record<"experience" | "pmcRaids" | "scavRaids" | "pmcSurvived" | "pmcDeaths" | "pmcKills" | "killedPmc", number>;
interface SnapshotRow {
  id: number; aid: number; profile_updated_at: number; upstream_updated_at: number; captured_at: number;
  nickname: string | null; stats_json: string;
}

const KEYS = ["experience", "pmcRaids", "scavRaids", "pmcSurvived", "pmcDeaths", "pmcKills", "killedPmc"] as const;
const DAY_MS = 86_400_000;

function parse(row: SnapshotRow): { counters: Counters | null; valid: boolean; nickname: string; hours: number } {
  try {
    const stats = JSON.parse(row.stats_json) as Record<string, unknown>;
    const counters = Object.fromEntries(KEYS.map((key) => [key, Number(stats[key])])) as Counters;
    return {
      counters,
      valid: Object.values(counters).every((value) => Number.isFinite(value) && value >= 0),
      nickname: String(stats.nickname || row.nickname || row.aid),
      hours: Number(stats.hoursPlayed),
    };
  } catch {
    return { counters: null, valid: false, nickname: String(row.nickname || row.aid), hours: 0 };
  }
}

/** Idempotently upgrades legacy regular snapshots into the shared progression model. */
export function materializeRegularProgression(db: SqliteDatabase, onlyAid?: number): { snapshots: number; intervals: number } {
  initializeSeasonalSchema(db);
  db.exec("SAVEPOINT materialize_regular_progression");
  try {
  const rows = db.prepare(`SELECT * FROM progression_snapshots
    WHERE mode = 'regular' AND cycle_id = 'persistent'
      AND NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = progression_snapshots.aid)
      ${onlyAid == null ? "" : "AND aid = ?"}
    ORDER BY aid, profile_updated_at, id`).all(...(onlyAid == null ? [] : [onlyAid])) as SnapshotRow[];
  const byAid = new Map<number, SnapshotRow[]>();
  for (const row of rows) byAid.set(Number(row.aid), [...(byAid.get(Number(row.aid)) ?? []), row]);
  let intervalCount = 0;
    const updateSnapshot = db.prepare(`UPDATE progression_snapshots SET profile_updated_at = ?,
      upstream_updated_at = ?, local_date = ?, series_id = ?, experience = ?, pmc_raids = ?,
      scav_raids = ?, pmc_survived = ?, pmc_deaths = ?, pmc_kills = ?, killed_pmc = ? WHERE id = ?`);
    const insertInterval = db.prepare(`INSERT INTO progression_intervals (
      mode, cycle_id, aid, from_snapshot_id, to_snapshot_id, ended_at, local_date, elapsed_days,
      status, experience, pmc_raids, scav_raids, pmc_survived, pmc_deaths, pmc_kills, killed_pmc,
      confidence, score_version
    ) VALUES ('regular', 'persistent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(mode, cycle_id, aid, from_snapshot_id, to_snapshot_id) DO UPDATE SET
      ended_at = excluded.ended_at, local_date = excluded.local_date, elapsed_days = excluded.elapsed_days,
      status = excluded.status, experience = excluded.experience, pmc_raids = excluded.pmc_raids,
      scav_raids = excluded.scav_raids, pmc_survived = excluded.pmc_survived,
      pmc_deaths = excluded.pmc_deaths, pmc_kills = excluded.pmc_kills,
      killed_pmc = excluded.killed_pmc, confidence = excluded.confidence, score_version = 1`);
    const upsertProfile = db.prepare(`INSERT INTO player_profiles (
      mode, cycle_id, aid, nickname, profile_updated_at, last_access_at, lifetime_pvp_hours,
      experience, pmc_raids, scav_raids, pmc_survived, pmc_deaths, pmc_kills, killed_pmc,
      first_seen_at, last_seen_at, snapshot_count, progression_eligible
    ) VALUES ('regular', 'persistent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(mode, cycle_id, aid) DO UPDATE SET nickname = excluded.nickname,
      profile_updated_at = excluded.profile_updated_at, last_access_at = excluded.last_access_at,
      lifetime_pvp_hours = excluded.lifetime_pvp_hours, experience = excluded.experience,
      pmc_raids = excluded.pmc_raids, scav_raids = excluded.scav_raids,
      pmc_survived = excluded.pmc_survived, pmc_deaths = excluded.pmc_deaths,
      pmc_kills = excluded.pmc_kills, killed_pmc = excluded.killed_pmc,
      first_seen_at = excluded.first_seen_at, last_seen_at = excluded.last_seen_at,
      snapshot_count = excluded.snapshot_count, progression_eligible = excluded.progression_eligible`);
    for (const [aid, history] of byAid) {
      let seriesId = 1;
      let raidIntervals = 0;
      let previous: { row: SnapshotRow; counters: Counters | null; valid: boolean } | null = null;
      for (const row of history) {
        const parsed = parse(row);
        const updatedAt = Number(row.profile_updated_at || row.upstream_updated_at);
        const date = new Date(updatedAt).toLocaleDateString("en-CA", { timeZone: "Europe/Moscow" });
        if (previous) {
          const changes = Object.fromEntries(KEYS.map((key) => [
            key, parsed.counters && previous!.counters ? parsed.counters[key] - previous!.counters[key] : 0,
          ])) as Counters;
          const negative = Object.values(changes).some((value) => value < 0);
          const reset = parsed.valid && previous.valid && changes.experience < 0 && changes.pmcRaids < 0;
          const status = !parsed.valid || !previous.valid || (negative && !reset) ? "schema_anomaly" : reset ? "reset" : "valid";
          if (status !== "valid") seriesId += 1;
          const elapsedDays = (updatedAt - Number(previous.row.profile_updated_at || previous.row.upstream_updated_at)) / DAY_MS;
          if (isRaidProgressionInterval(status, changes.pmcRaids)) raidIntervals += 1;
          insertInterval.run(aid, previous.row.id, row.id, updatedAt, date, elapsedDays, status,
            ...KEYS.map((key) => changes[key]), status === "valid" && elapsedDays > 0 ? Math.min(1, 1 / elapsedDays) : 0);
          intervalCount += 1;
        }
        const counters = parsed.counters ?? Object.fromEntries(KEYS.map((key) => [key, 0])) as Counters;
        updateSnapshot.run(updatedAt, updatedAt, date, seriesId, ...KEYS.map((key) => counters[key]), row.id);
        previous = { row: { ...row, profile_updated_at: updatedAt }, counters: parsed.counters, valid: parsed.valid };
      }
      const latest = history.at(-1)!;
      const parsed = parse(latest);
      if (parsed.counters) upsertProfile.run(aid, parsed.nickname,
        Number(latest.profile_updated_at || latest.upstream_updated_at), Number(latest.captured_at),
        Number.isFinite(parsed.hours) ? parsed.hours : null, ...KEYS.map((key) => parsed.counters![key]),
        Number(history[0].captured_at), Number(latest.captured_at), history.length, raidIntervals >= 2 ? 1 : 0);
    }
    refreshSqliteProgressionAggregates(db, "regular", "persistent");
    db.exec("RELEASE materialize_regular_progression");
    return { snapshots: rows.length, intervals: intervalCount };
  } catch (error) {
    db.exec("ROLLBACK TO materialize_regular_progression");
    db.exec("RELEASE materialize_regular_progression");
    throw error;
  }
}
