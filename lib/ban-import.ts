import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import type { DatabaseSync } from "node:sqlite";
import { BAN_SCHEMA } from "./ban-db.ts";
import { lastSkillAccessSeconds, parseArenaProfileStats, parseProfileStats, PLAYER_LEVELS_V2026_07_22 } from "./tarkov-api.ts";
import type { PlayerProfile } from "../types/tarkov.ts";

export const BAN_PROFILE_PATHS = { regular: "profile", pve: "pve", arena: "arena", seasonal: "pvp-season" } as const;
export type BanProfileMode = keyof typeof BAN_PROFILE_PATHS;
export interface BanWave { date: string; source: string; nicknames: string[] }
export interface BanCandidate { aid: number; nickname: string; waves: BanWave[] }
export interface BanProfile { mode: BanProfileMode; raw: string; cycleId?: string }
export type BanImportDecision = "accepted" | "missing_pvp" | "missing_skill_date" | "active_after_wave";
const MAX_PROFILE_BYTES = 8 * 1024 * 1024;

export function waveCutoff(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("wave date must be YYYY-MM-DD");
  const start = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== date) throw new Error("invalid wave date");
  return start + 86_400_000 - 1;
}

export function validateWave(wave: BanWave): BanWave {
  waveCutoff(wave.date);
  const source = new URL(wave.source);
  if (source.protocol !== "https:" || source.username || source.password) throw new Error("invalid wave source");
  if (!Array.isArray(wave.nicknames) || !wave.nicknames.length || wave.nicknames.some(n => typeof n !== "string" || !/^[a-zA-Z0-9_-]{1,15}$/.test(n))) {
    throw new Error("invalid wave nicknames");
  }
  return wave;
}

export function parseBanProfile(input: BanProfile, aid: number): PlayerProfile {
  if (!Object.hasOwn(BAN_PROFILE_PATHS, input.mode) || typeof input.raw !== "string" || Buffer.byteLength(input.raw) > MAX_PROFILE_BYTES) throw new Error("invalid profile input");
  const profile = JSON.parse(input.raw) as PlayerProfile;
  if (Number(profile?.aid) !== aid || !profile.info || typeof profile.info.nickname !== "string") throw new Error("profile identity mismatch");
  if (!Number.isSafeInteger(profile.updated) || Number(profile.updated) <= 0) throw new Error("profile version missing");
  const counters = profile.pmcStats?.eft?.overAllCounters;
  if (input.mode === "arena" ? !profile.stat?.arenaOverAllCounters : !counters || (counters.Items !== null && !Array.isArray(counters.Items))) throw new Error("profile counters missing");
  if (input.mode === "seasonal" && (!input.cycleId || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(input.cycleId))) throw new Error("seasonal cycle missing");
  return profile;
}

/** Preserve original statistical sections, including counters unknown to today's parser. */
export function characterStatisticsJson(profile: PlayerProfile): string {
  return JSON.stringify(Object.fromEntries(
    ["aid", "info", "pmcStats", "scavStats", "stat", "skills", "achievements", "updated"]
      .filter(key => Object.hasOwn(profile, key)).map(key => [key, profile[key]])
  ));
}

export function evaluateBanCandidate(candidate: BanCandidate, profiles: BanProfile[]): BanImportDecision {
  if (!Number.isSafeInteger(candidate.aid) || candidate.aid <= 0 || !candidate.waves.length || typeof candidate.nickname !== "string" ||
    candidate.waves.some(w => !w.nicknames.some(n => n.toLowerCase() === candidate.nickname.toLowerCase()))) throw new Error("invalid ban candidate");
  const cutoff = Math.max(...candidate.waves.map(w => waveCutoff(validateWave(w).date)));
  const parsed = profiles.map(input => ({ input, profile: parseBanProfile(input, candidate.aid) }));
  const pvp = parsed.find(p => p.input.mode === "regular");
  if (!pvp) return "missing_pvp";
  if (lastSkillAccessSeconds(pvp.profile) === null) return "missing_skill_date";
  if (parsed.some(p => (lastSkillAccessSeconds(p.profile) ?? 0) * 1000 > cutoff)) return "active_after_wave";
  return "accepted";
}

export const BAN_IMPORT_SCHEMA = `
CREATE TABLE IF NOT EXISTS banned_mode_snapshots (
  aid INTEGER NOT NULL REFERENCES banned_accounts(aid) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('regular','pve','arena','seasonal')),
  cycle_id TEXT NOT NULL, profile_updated_at INTEGER NOT NULL, captured_at INTEGER NOT NULL,
  last_played_at INTEGER, nickname TEXT NOT NULL, raw_json_gzip BLOB NOT NULL,
  raw_sha256 TEXT NOT NULL, stats_json TEXT NOT NULL,
  PRIMARY KEY(aid, mode, cycle_id, profile_updated_at)
);
CREATE TABLE IF NOT EXISTS banned_wave_evidence (
  aid INTEGER NOT NULL REFERENCES banned_accounts(aid) ON DELETE CASCADE,
  listed_date TEXT NOT NULL, nickname TEXT NOT NULL, source TEXT NOT NULL,
  PRIMARY KEY(aid, listed_date, nickname, source)
);
CREATE TABLE IF NOT EXISTS banned_stored_rows (
  aid INTEGER NOT NULL REFERENCES banned_accounts(aid) ON DELETE CASCADE,
  source_table TEXT NOT NULL, source_key TEXT NOT NULL, row_json_gzip BLOB NOT NULL,
  PRIMARY KEY(aid, source_table, source_key)
);
CREATE TABLE IF NOT EXISTS ban_import_results (
  aid INTEGER NOT NULL, evidence_hash TEXT NOT NULL, decision TEXT NOT NULL,
  checked_at INTEGER NOT NULL, PRIMARY KEY(aid,evidence_hash)
);`;

export function initializeBanImportDb(db: DatabaseSync) {
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(BAN_SCHEMA + BAN_IMPORT_SCHEMA);
}

export function candidateEvidenceHash(candidate: BanCandidate): string {
  return createHash("sha256").update(JSON.stringify({ aid: candidate.aid, nickname: candidate.nickname,
    waves: candidate.waves.map(w => [w.date, w.source]).sort() })).digest("hex");
}

/** Caller owns the transaction; copy complete rows without deleting live history. */
function archiveLocalRows(db: DatabaseSync, aid: number) {
  const attached = new Set(db.prepare("PRAGMA database_list").all().map(r => String(r.name)));
  const tables = { players_db: ["players", "mode_players", "arena_mode_stats", "arena_mode_stats_history"],
    progression_db: ["player_profiles", "progression_snapshots", "progression_intervals"] };
  for (const [schema, names] of Object.entries(tables)) {
    if (!attached.has(schema)) continue;
    for (const name of names) {
      if (!db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type='table' AND name=?`).get(name)) continue;
      const keys = db.prepare(`PRAGMA ${schema}.table_info(${name})`).all().filter(r => Number(r.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk)).map(r => String(r.name));
      if (!keys.length) throw new Error(`archive source has no primary key: ${schema}.${name}`);
      for (const row of db.prepare(`SELECT * FROM ${schema}.${name} WHERE aid=?`).all(aid)) {
        const identity = [...new Set([...keys, "profile_updated_at", "upstream_version", "parser_version"].filter(k => Object.hasOwn(row, k)))];
        db.prepare("INSERT OR IGNORE INTO banned_stored_rows VALUES(?,?,?,?)")
          .run(aid, `${schema}.${name}`, JSON.stringify(identity.map(k => row[k])), gzipSync(Buffer.from(JSON.stringify(row))));
      }
    }
    if (!db.prepare(`SELECT 1 FROM ${schema}.sqlite_master WHERE type='table' AND name='excluded_players'`).get()) throw new Error(`${schema} exclusion schema missing`);
    db.prepare(`INSERT INTO ${schema}.excluded_players(aid,reason,created_at) VALUES(?,'confirmed_ban',?) ON CONFLICT(aid) DO NOTHING`).run(aid, Date.now());
  }
  if (attached.has("progression_db") && db.prepare("SELECT 1 FROM progression_db.sqlite_master WHERE type='table' AND name='player_profiles'").get()) {
    db.prepare("UPDATE progression_db.player_profiles SET confirmed_banned=1 WHERE aid=?").run(aid);
  }
}

export function importBanCandidate(db: DatabaseSync, candidate: BanCandidate, profiles: BanProfile[], now = Date.now()): BanImportDecision {
  const decision = evaluateBanCandidate(candidate, profiles);
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("invalid capture time");
  const evidenceHash = candidateEvidenceHash(candidate);
  db.exec("BEGIN IMMEDIATE");
  try {
    if (decision === "accepted") {
      const latestWave = candidate.waves.toSorted((a, b) => b.date.localeCompare(a.date))[0];
      const updated = Math.max(...profiles.map(p => Number(parseBanProfile(p, candidate.aid).updated)));
      db.prepare(`INSERT INTO banned_accounts VALUES(?,?,?,'published_ban_list_nickname_match','listed',NULL,?)
        ON CONFLICT(aid) DO UPDATE SET last_confirmed_at=MAX(last_confirmed_at,excluded.last_confirmed_at),
        profile_updated_at=MAX(profile_updated_at,excluded.profile_updated_at)`)
        .run(candidate.aid, waveCutoff(latestWave.date), now, updated);
      for (const wave of candidate.waves) {
        const inserted = db.prepare("INSERT OR IGNORE INTO banned_wave_evidence VALUES(?,?,?,?)")
          .run(candidate.aid, wave.date, candidate.nickname, wave.source);
        if (inserted.changes) db.prepare("INSERT INTO ban_confirmations(aid,confirmed_at,source,raw_status,reason) VALUES(?,?,'published_ban_list_nickname_match','listed',?)")
          .run(candidate.aid, now, `${wave.date} ${wave.source}`);
      }
      for (const input of profiles) {
        const profile = parseBanProfile(input, candidate.aid);
        const stats = input.mode === "arena" ? parseArenaProfileStats(profile) : parseProfileStats(profile, [...PLAYER_LEVELS_V2026_07_22]);
        const cycle = input.mode === "seasonal" ? input.cycleId! : "persistent";
        const raw = characterStatisticsJson(profile);
        const hash = createHash("sha256").update(raw).digest("hex");
        const existing = db.prepare("SELECT raw_sha256 FROM banned_mode_snapshots WHERE aid=? AND mode=? AND cycle_id=? AND profile_updated_at=?")
          .get(candidate.aid, input.mode, cycle, Number(profile.updated));
        if (existing && existing.raw_sha256 !== hash) throw new Error("profile payload changed without a version change");
        db.prepare("INSERT OR IGNORE INTO banned_mode_snapshots VALUES(?,?,?,?,?,?,?,?,?,?)")
          .run(candidate.aid, input.mode, cycle, Number(profile.updated), now,
            (lastSkillAccessSeconds(profile) ?? 0) * 1000 || null, profile.info.nickname,
            gzipSync(Buffer.from(raw)), hash, JSON.stringify(stats));
      }
      archiveLocalRows(db, candidate.aid);
    }
    db.prepare("INSERT INTO ban_import_results VALUES(?,?,?,?) ON CONFLICT(aid,evidence_hash) DO UPDATE SET decision=excluded.decision,checked_at=excluded.checked_at")
      .run(candidate.aid, evidenceHash, decision, now);
    db.exec("COMMIT");
    return decision;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function readArchivedBanProfile(db: DatabaseSync, aid: number, mode: BanProfileMode, cycleId = "persistent"): PlayerProfile | null {
  const row = db.prepare("SELECT raw_json_gzip,raw_sha256 FROM banned_mode_snapshots WHERE aid=? AND mode=? AND cycle_id=? ORDER BY profile_updated_at DESC LIMIT 1")
    .get(aid, mode, cycleId);
  if (!row) return null;
  const raw = gunzipSync(row.raw_json_gzip as Uint8Array, { maxOutputLength: MAX_PROFILE_BYTES }).toString("utf8");
  if (createHash("sha256").update(raw).digest("hex") !== row.raw_sha256) throw new Error("archived profile checksum mismatch");
  return parseBanProfile({ mode, cycleId, raw }, aid);
}
