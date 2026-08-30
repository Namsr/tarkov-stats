export type PublishedAchievementMode = "regular" | "pve";

export interface PublishedAchievementStat {
  ach_id: string;
  owners: number;
  meanHours: number;
  stdHours: number;
  earlyHours: number;
}

export interface PublishedAchievementBaseline {
  mode: PublishedAchievementMode;
  generation: number;
  generatedAt: number;
  total: number;
  achievements: PublishedAchievementStat[];
}

export const ACHIEVEMENT_BASELINE_PUBLICATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS achievement_baseline_publications (
  mode TEXT PRIMARY KEY CHECK (mode IN ('regular', 'pve')),
  generation INTEGER NOT NULL,
  generated_at INTEGER NOT NULL,
  total INTEGER NOT NULL,
  achievements_json TEXT NOT NULL
);
`;

const BASELINE_SELECT_SQL = `WITH expanded AS (
  SELECT je.value AS ach_id, p.hours AS hours
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
  MIN(CASE WHEN rn = CAST((owners + 4) / 5 AS INTEGER) THEN hours END) AS early_hours
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
      earlyHours: Number(row.early_hours) || mean,
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
      const numbers = [entry.owners, entry.meanHours, entry.stdHours, entry.earlyHours].map(Number);
      if (!achId || numbers.some((number) => !Number.isFinite(number) || number < 0)) return [];
      return [{
        ach_id: achId,
        owners: numbers[0],
        meanHours: numbers[1],
        stdHours: numbers[2],
        earlyHours: numbers[3],
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
