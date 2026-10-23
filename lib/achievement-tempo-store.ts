import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { reissueEditedTriggers, sqliteTrigger } from "./sqlite-trigger-ddl.ts";
import { TEMPO_TTL_MS, TEMPO_VERSION, TEMPO_TRANSITIONS, parseTempoUnlocks, measureTempo,
  evaluateTempo, summarizeTempo, type TempoScope, type TempoUnlocks, type TempoCohort,
  type TempoPublication } from "./achievement-tempo.ts";

export const TEMPO_SCHEMA = `
CREATE TABLE IF NOT EXISTS achievement_tempo_profiles (
  mode TEXT NOT NULL, cycle_id TEXT NOT NULL, aid INTEGER NOT NULL,
  revision INTEGER NOT NULL, observed_at INTEGER NOT NULL, unlocks_json TEXT NOT NULL,
  PRIMARY KEY(mode, cycle_id, aid)
);
CREATE TABLE IF NOT EXISTS achievement_tempo_publications (
  mode TEXT NOT NULL, cycle_id TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(mode, cycle_id)
);`;

/** Only the scheduled worker installs DDL. Web requests open both files read-only. */
export function initializeTempoExclusions(db: DatabaseSync) {
  const triggers = ["insert", "update", "delete"].flatMap((event) => [
    sqliteTrigger(`tempo_exclusions_${event}`, `AFTER ${event.toUpperCase()} ON excluded_players BEGIN
      UPDATE achievement_tempo_exclusions SET revision = revision + 1 WHERE id = 1; END;`),
    sqliteTrigger(`tempo_bans_${event}`, `AFTER ${event.toUpperCase()} ON player_profiles
      WHEN ${event === "insert" ? "NEW.confirmed_banned != 0" : event === "delete" ? "OLD.confirmed_banned != 0"
    : "OLD.confirmed_banned IS NOT NEW.confirmed_banned OR (OLD.aid IS NOT NEW.aid AND (OLD.confirmed_banned != 0 OR NEW.confirmed_banned != 0))"}
      BEGIN UPDATE achievement_tempo_exclusions SET revision = revision + 1 WHERE id = 1; END;`),
  ]);
  db.exec("SAVEPOINT tempo_schema");
  try {
    db.exec("CREATE TABLE IF NOT EXISTS achievement_tempo_exclusions(id INTEGER PRIMARY KEY CHECK(id=1), seed TEXT NOT NULL, revision INTEGER NOT NULL)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_tempo_confirmed_bans ON player_profiles(aid) WHERE confirmed_banned != 0");
    db.prepare("INSERT OR IGNORE INTO achievement_tempo_exclusions VALUES (1, ?, 0)").run(randomUUID());
    const missing = triggers.some(({ name }) => !db.prepare("SELECT 1 FROM sqlite_master WHERE name=? AND type='trigger'").get(name));
    reissueEditedTriggers(db, triggers);
    for (const { ddl } of triggers) db.exec(ddl);
    if (missing) db.exec("UPDATE achievement_tempo_exclusions SET revision = revision + 1 WHERE id=1");
    db.exec("RELEASE tempo_schema");
  } catch (error) {
    db.exec("ROLLBACK TO tempo_schema; RELEASE tempo_schema");
    throw error;
  }
}

export function tempoExclusions(db: DatabaseSync): string {
  const row = db.prepare("SELECT seed, revision FROM achievement_tempo_exclusions WHERE id=1").get();
  if (!row) throw new Error("tempo_exclusions_unavailable");
  return `${row.seed}:${row.revision}`;
}

export function readTempoPublication(db: DatabaseSync, scope: TempoScope): TempoPublication | null {
  const row = db.prepare("SELECT payload FROM achievement_tempo_publications WHERE mode=? AND cycle_id=?").get(scope.mode, scope.cycleId);
  if (!row) return null;
  const value = JSON.parse(String(row.payload)) as TempoPublication;
  return value.version === TEMPO_VERSION && value.scope.startsAt === scope.startsAt
    && value.scope.endsAt === scope.endsAt ? value : null;
}

/** Incremental decoding: unchanged source revisions reuse compact, normalized dates.
 * The separate output file keeps large transactions off the capture database.
 * A source read transaction gives the whole generation one consistent snapshot.
 */
export function materializeTempo(source: DatabaseSync, output: DatabaseSync, scope: TempoScope,
  { now = Date.now(), deadline = Date.now() + 180_000, force = false } = {}) {
  output.exec(TEMPO_SCHEMA);
  const previous = readTempoPublication(output, scope);
  const checkDeadline = () => { if (Date.now() >= deadline) throw new Error("tempo_deadline"); };
  source.exec("BEGIN");
  try {
    const exclusions = tempoExclusions(source);
    if (!force && previous && previous.exclusions === exclusions
      && now >= previous.generatedAt && now - previous.generatedAt < TEMPO_TTL_MS) return { skipped: true, decoded: 0 };
    const cached = new Map<number, { revision: number; observedAt: number; unlocks: TempoUnlocks }>();
    for (const row of previous ? output.prepare("SELECT * FROM achievement_tempo_profiles WHERE mode=? AND cycle_id=?").iterate(scope.mode, scope.cycleId) : []) {
      cached.set(Number(row.aid), { revision: Number(row.revision), observedAt: Number(row.observed_at), unlocks: JSON.parse(String(row.unlocks_json)) });
    }
    const latest = source.prepare(`SELECT profile_updated_at, stats_json, achievements FROM progression_snapshots
      WHERE mode=? AND cycle_id=? AND aid=? ORDER BY profile_updated_at DESC, id DESC LIMIT 1`);
    const save = output.prepare(`INSERT INTO achievement_tempo_profiles VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(mode, cycle_id, aid) DO UPDATE SET revision=excluded.revision,
      observed_at=excluded.observed_at, unlocks_json=excluded.unlocks_json`);
    const cohorts: TempoCohort[] = TEMPO_TRANSITIONS.map(({ key }) => ({ key, values: [], omitted: {} }));
    let profiles = 0, decoded = 0;
    output.exec("BEGIN IMMEDIATE");
    try {
      for (const row of source.prepare(`SELECT p.aid,
        EXISTS(SELECT 1 FROM player_profiles b WHERE b.aid=p.aid AND b.confirmed_banned != 0) AS banned,
        COALESCE(r.revision, 0) AS revision,
        EXISTS(SELECT 1 FROM excluded_players e WHERE e.aid=p.aid) AS excluded
        FROM player_profiles p LEFT JOIN progression_personal_revisions r
          ON r.mode=p.mode AND r.cycle_id=p.cycle_id AND r.aid=p.aid
        WHERE p.mode=? AND p.cycle_id=? ORDER BY p.aid`).iterate(scope.mode, scope.cycleId)) {
        checkDeadline();
        const aid = Number(row.aid), revision = Number(row.revision);
        let profile = cached.get(aid);
        if (!profile || revision === 0 || profile.revision !== revision) {
          const snapshot = latest.get(scope.mode, scope.cycleId, aid);
          if (!snapshot) continue;
          profile = { revision, observedAt: Number(snapshot.profile_updated_at),
            unlocks: parseTempoUnlocks(String(snapshot.stats_json), snapshot.achievements == null ? null : String(snapshot.achievements), now) };
          save.run(scope.mode, scope.cycleId, aid, revision, profile.observedAt, JSON.stringify(profile.unlocks));
          decoded++;
        }
        if (row.excluded || row.banned) continue;
        profiles++;
        const measurements = measureTempo(profile.unlocks, scope);
        measurements.forEach((measurement, i) => {
          if (measurement.reason) cohorts[i].omitted[measurement.reason] = (cohorts[i].omitted[measurement.reason] ?? 0) + 1;
          else cohorts[i].values.push([measurement.days!, aid]);
        });
      }
      for (const cohort of cohorts) {
        checkDeadline();
        cohort.values.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      }
      const publication: TempoPublication = { version: TEMPO_VERSION, scope, exclusions, generatedAt: now, profiles, cohorts };
      output.prepare(`INSERT INTO achievement_tempo_publications VALUES (?, ?, ?)
        ON CONFLICT(mode, cycle_id) DO UPDATE SET payload=excluded.payload`).run(scope.mode, scope.cycleId, JSON.stringify(publication));
      checkDeadline();
      output.exec("COMMIT");
      return { skipped: false, decoded, profiles, cohorts: cohorts.map(summarizeTempo) };
    } catch (error) {
      output.exec("ROLLBACK");
      throw error;
    }
  } finally { source.exec("ROLLBACK"); }
}

export function readTempoReport(source: DatabaseSync, output: DatabaseSync, scope: TempoScope, aid: number | null, now = Date.now()) {
  const publication = readTempoPublication(output, scope);
  const base = { experimental: true as const, affectsPublicRisk: false as const, scope };
  if (!publication) return { ...base, available: false as const, reason: "not_published" as const };
  if (publication.exclusions !== tempoExclusions(source)) return { ...base, available: false as const, reason: "exclusions_changed" as const };
  if (now < publication.generatedAt || now - publication.generatedAt > 2 * TEMPO_TTL_MS) {
    return { ...base, available: false as const, reason: "publication_expired" as const };
  }
  const row = aid === null ? null : output.prepare("SELECT observed_at, unlocks_json FROM achievement_tempo_profiles WHERE mode=? AND cycle_id=? AND aid=?").get(scope.mode, scope.cycleId, aid);
  const measurements = row ? measureTempo(JSON.parse(String(row.unlocks_json)), scope) : [];
  const evaluations = measurements.map((measurement, i) => evaluateTempo(measurement, publication.cohorts[i], aid!));
  return { ...base, available: true as const, generatedAt: publication.generatedAt, profiles: publication.profiles,
    stale: now - publication.generatedAt > TEMPO_TTL_MS,
    cohorts: publication.cohorts.map(summarizeTempo), aid, observedAt: row ? Number(row.observed_at) : null,
    evaluations, strongest: evaluations.filter((item) => item.percentile !== null)
      .sort((a, b) => a.percentile! - b.percentile!)[0]?.key ?? null };
}

export type TempoReport = ReturnType<typeof readTempoReport>;
