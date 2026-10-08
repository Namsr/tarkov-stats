import { ACHIEVEMENT_UNLOCK_P1_MIN_SAMPLE, firstFiniteHours } from "./achievement-unlock-hours.ts";

export type PublishedAchievementMode = "regular" | "pve";

export interface PublishedAchievementStat {
  /** Valid observed owner-hour count; absent in legacy publications. */
  hoursOwners?: number;
  ach_id: string;
  owners: number;
  meanHours: number;
  stdHours: number;
  earlyHours: number;
  unlockHours: number;
}

export interface PublishedAchievementBaseline {
  mode: PublishedAchievementMode;
  generation: number;
  generatedAt: number;
  total: number;
  achievements: PublishedAchievementStat[];
}

export const ACHIEVEMENT_BASELINE_PUBLICATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS regular_risk_achievement_owners (
  aid INTEGER NOT NULL, ach_id TEXT NOT NULL, hours REAL NOT NULL,
  PRIMARY KEY (aid, ach_id)
);
CREATE INDEX IF NOT EXISTS idx_regular_risk_achievement_hours
  ON regular_risk_achievement_owners(ach_id, hours, aid);
CREATE TABLE IF NOT EXISTS regular_risk_reference_state (
  id INTEGER PRIMARY KEY CHECK (id = 1), generated_at INTEGER NOT NULL, total INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS achievement_baseline_publications (
  mode TEXT PRIMARY KEY CHECK (mode IN ('regular', 'pve')),
  generation INTEGER NOT NULL,
  generated_at INTEGER NOT NULL,
  total INTEGER NOT NULL,
  achievements_json TEXT NOT NULL
);
`;

/** Build the risk index independently of the much larger display-percentile sort. */
export function materializeRegularRiskAchievementOwners(
  db: { exec(sql: string): void; prepare(sql: string): {
    get(...params: unknown[]): Record<string, unknown> | undefined;
    run(...params: unknown[]): unknown;
  } },
  now = Date.now(),
): void {
  db.exec(ACHIEVEMENT_BASELINE_PUBLICATION_SCHEMA);
  db.exec("SAVEPOINT publish_regular_risk_owners");
  try {
    db.exec(`DELETE FROM regular_risk_achievement_owners;
      INSERT OR IGNORE INTO regular_risk_achievement_owners(aid, ach_id, hours)
      SELECT p.aid, je.value, p.hours FROM players p,
        json_each(CASE WHEN json_valid(p.achievements) THEN p.achievements ELSE '[]' END) je
      WHERE p.hours > 0 AND p.hours < 1e100 AND je.type = 'text' AND length(je.value) > 0
        AND NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = p.aid)`);
    const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM players p
      WHERE NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = p.aid)`).get()?.n ?? 0);
    db.prepare(`INSERT INTO regular_risk_reference_state(id, generated_at, total) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET generated_at = excluded.generated_at, total = excluded.total`).run(now, total);
    db.exec("RELEASE publish_regular_risk_owners");
  } catch (error) {
    db.exec("ROLLBACK TO publish_regular_risk_owners; RELEASE publish_regular_risk_owners");
    throw error;
  }
}

/** Indexed owner samples; no per-profile expansion of players.achievements. */
export function readRegularRiskAchievementBaseline(
  db: { prepare(sql: string): { get(...params: unknown[]): Record<string, unknown> | undefined } },
  ownedIds: readonly string[],
  excludeAid: number,
): { total: number; achievements: PublishedAchievementStat[] } {
  const publication = readPublishedAchievementBaseline(db, "regular");
  const hasState = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'regular_risk_reference_state'").get();
  const state = hasState ? db.prepare("SELECT total FROM regular_risk_reference_state WHERE id = 1").get() : undefined;
  const achievements: PublishedAchievementStat[] = [];
  for (const id of new Set(ownedIds)) {
    const where = `WHERE ach_id = ? AND aid != ? AND hours > 0 AND hours < 1e100
      AND EXISTS (SELECT 1 FROM players p WHERE p.aid = regular_risk_achievement_owners.aid)
      AND NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = regular_risk_achievement_owners.aid)`;
    const row = db.prepare(`SELECT COUNT(*) AS n, AVG(hours) AS mean, AVG(hours * hours) AS square
      FROM regular_risk_achievement_owners ${where}`).get(id, excludeAid);
    const n = Number(row?.n ?? 0);
    const mean = Number(row?.mean ?? 0);
    const p20 = n ? db.prepare(`SELECT hours FROM regular_risk_achievement_owners ${where}
      ORDER BY hours, aid LIMIT 1 OFFSET ?`).get(id, excludeAid, Math.ceil(n * 0.2) - 1) : undefined;
    achievements.push({ ach_id: id, owners: n, hoursOwners: n, meanHours: mean,
      stdHours: Math.sqrt(Math.max(0, Number(row?.square ?? 0) - mean * mean)),
      earlyHours: Number(p20?.hours ?? 0), unlockHours: Number(p20?.hours ?? 0) });
  }
  return { total: Math.max(0, Number(state?.total ?? publication?.total ?? 0) - 1), achievements };
}

const BASELINE_SELECT_SQL = `WITH expanded AS (
  SELECT DISTINCT p.aid, je.value AS ach_id, p.hours AS hours
  FROM __SOURCE__ AS p, json_each(p.achievements) AS je
  WHERE __MODE_FILTER__
    AND p.achievements IS NOT NULL AND p.achievements != ''
    AND NOT EXISTS (SELECT 1 FROM excluded_players tombstone WHERE tombstone.aid = p.aid)
), ranked AS (
  SELECT ach_id, hours,
    COUNT(*) OVER (PARTITION BY ach_id) AS owners,
    AVG(hours) OVER (PARTITION BY ach_id) AS mean_hours,
    AVG(hours * hours) OVER (PARTITION BY ach_id) AS mean_sq,
    ROW_NUMBER() OVER (PARTITION BY ach_id ORDER BY hours) AS rn
  FROM expanded
)
SELECT ach_id, MAX(owners) AS owners, MAX(mean_hours) AS mean_hours,
  MAX(mean_sq) AS mean_sq,
  MIN(CASE WHEN rn = CAST((owners + 4) / 5 AS INTEGER) THEN hours END) AS early_hours,
  MIN(CASE WHEN rn = CASE
    WHEN owners >= ${ACHIEVEMENT_UNLOCK_P1_MIN_SAMPLE} THEN CAST((owners + 99) / 100 AS INTEGER)
    ELSE CAST((owners + 19) / 20 AS INTEGER)
  END THEN hours END) AS unlock_hours
FROM ranked GROUP BY ach_id`;

function baselineSql(mode: PublishedAchievementMode): { sql: string; params: unknown[] } {
  return mode === "regular"
    ? { sql: BASELINE_SELECT_SQL.replace("__SOURCE__", "players").replace("__MODE_FILTER__", "1 = 1"), params: [] }
    : { sql: BASELINE_SELECT_SQL.replace("__SOURCE__", "mode_players").replace("__MODE_FILTER__", "p.mode = ?"), params: [mode] };
}

function totalSql(mode: PublishedAchievementMode): { sql: string; params: unknown[] } {
  const source = mode === "regular" ? "players" : "mode_players";
  const filter = mode === "regular" ? "1 = 1" : "p.mode = ?";
  return {
    sql: `SELECT COUNT(*) AS n FROM ${source} AS p WHERE ${filter}
      AND NOT EXISTS (SELECT 1 FROM excluded_players tombstone WHERE tombstone.aid = p.aid)`,
    params: mode === "regular" ? [] : [mode],
  };
}

function toAchievementStats(rows: readonly Record<string, unknown>[]): PublishedAchievementStat[] {
  return rows.map((row) => {
    const mean = Number(row.mean_hours) || 0;
    const variance = Math.max(0, (Number(row.mean_sq) || 0) - mean * mean);
    return {
      ach_id: String(row.ach_id),
      owners: Number(row.owners) || 0,
      meanHours: mean,
      stdHours: Math.sqrt(variance),
      earlyHours: firstFiniteHours(row.early_hours, mean),
      unlockHours: firstFiniteHours(row.unlock_hours, mean),
    };
  });
}

export function parsePublishedAchievementBaseline(
  row: Record<string, unknown> | null | undefined,
): PublishedAchievementBaseline | null {
  if (!row || (row.mode !== "regular" && row.mode !== "pve")) return null;
  try {
    const parsed = JSON.parse(String(row.achievements_json)) as unknown;
    if (!Array.isArray(parsed)) return null;
    const achievements = parsed.flatMap((value): PublishedAchievementStat[] => {
      if (!value || typeof value !== "object") return [];
      const entry = value as Record<string, unknown>;
      const achId = typeof entry.ach_id === "string" ? entry.ach_id : "";
      const numbers = [
        entry.owners,
        entry.meanHours,
        entry.stdHours,
        entry.earlyHours,
        entry.unlockHours ?? entry.earlyHours,
      ].map(Number);
      if (!achId || numbers.some((number) => !Number.isFinite(number) || number < 0)) return [];
      return [{
        ach_id: achId,
        owners: numbers[0],
        ...(Number.isSafeInteger(entry.hoursOwners) && Number(entry.hoursOwners) >= 0 && Number(entry.hoursOwners) <= numbers[0] ? { hoursOwners: Number(entry.hoursOwners) } : {}),
        meanHours: numbers[1],
        stdHours: numbers[2],
        earlyHours: numbers[3],
        unlockHours: numbers[4],
      }];
    });
    if (achievements.length !== parsed.length) return null;
    const generation = Number(row.generation);
    const generatedAt = Number(row.generated_at);
    const total = Number(row.total);
    if (![generation, generatedAt, total].every(Number.isFinite) || total < 0) return null;
    return { mode: row.mode, generation, generatedAt, total, achievements };
  } catch {
    return null;
  }
}

export function readPublishedAchievementBaseline(
  db: { prepare(sql: string): { get(...params: unknown[]): Record<string, unknown> | undefined } },
  mode: PublishedAchievementMode,
): PublishedAchievementBaseline | null {
  const row = db.prepare(`SELECT mode, generation, generated_at, total, achievements_json
    FROM achievement_baseline_publications WHERE mode = ?`).get(mode);
  return parsePublishedAchievementBaseline(row);
}

export function materializeAchievementBaseline(
  db: {
    exec(sql: string): void;
    prepare(sql: string): {
      all(...params: unknown[]): Record<string, unknown>[];
      get(...params: unknown[]): Record<string, unknown> | undefined;
      run(...params: unknown[]): unknown;
    };
  },
  mode: PublishedAchievementMode,
  now = Date.now(),
): PublishedAchievementBaseline {
  db.exec(ACHIEVEMENT_BASELINE_PUBLICATION_SCHEMA);
  const count = totalSql(mode);
  const selection = baselineSql(mode);
  const total = Number(db.prepare(count.sql).get(...count.params)?.n ?? 0);
  const achievements = toAchievementStats(db.prepare(selection.sql).all(...selection.params));
  const publication = { mode, generation: now, generatedAt: now, total, achievements };
  db.exec("SAVEPOINT publish_achievement_baseline");
  try {
    if (mode === "regular") {
      materializeRegularRiskAchievementOwners(db, now);
    }
    db.prepare(`INSERT INTO achievement_baseline_publications
      (mode, generation, generated_at, total, achievements_json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(mode) DO UPDATE SET generation = excluded.generation,
        generated_at = excluded.generated_at, total = excluded.total,
        achievements_json = excluded.achievements_json`).run(
      mode,
      now,
      now,
      total,
      JSON.stringify(achievements),
    );
    db.exec("RELEASE publish_achievement_baseline");
    return publication;
  } catch (error) {
    db.exec("ROLLBACK TO publish_achievement_baseline");
    db.exec("RELEASE publish_achievement_baseline");
    throw error;
  }
}
