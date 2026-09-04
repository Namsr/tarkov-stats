import { DatabaseSync } from "node:sqlite";

const dbPath = process.env.SQLITE_PATH || "/data/players.db";
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 30000");

for (const table of ["arena_mode_stats", "arena_mode_stats_history"]) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN best_arp REAL`);
    console.log(`added best_arp to ${table}`);
  } catch {
    console.log(`best_arp already exists on ${table}`);
  }
}

function validArp(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** BestArp may be stored as a plain object, an Items array, or [{Key, Value}]. */
function arpFromCounters(counters) {
  if (!counters) return null;
  if (Array.isArray(counters)) {
    const item = counters.find(
      ({ Key }) => Key === "BestArp" || (Array.isArray(Key) && Key.length === 1 && Key[0] === "BestArp"),
    );
    return item ? validArp(item.Value) : null;
  }
  if (typeof counters !== "object") return null;
  const items = counters.Items;
  if (Array.isArray(items)) return arpFromCounters(items);
  return validArp(counters.BestArp);
}

function arpFromRawJson(rawJson) {
  try {
    const parsed = JSON.parse(String(rawJson ?? ""));
    return arpFromCounters(parsed?.sourceCounters?.Counters) ?? arpFromCounters(parsed?.sourceCounters);
  } catch {
    return null;
  }
}

function arpFromLegacyStats(statsJson) {
  try {
    const parsed = JSON.parse(String(statsJson ?? ""));
    const candidates = [
      parsed?.arena?.bestArp,
      parsed?.arenaProfile?.overall?.bestArp,
      parsed?.stats?.arena?.bestArp,
    ];
    for (const candidate of candidates) {
      const arp = validArp(candidate);
      if (arp !== null) return arp;
    }
    return null;
  } catch {
    return null;
  }
}

const rows = db.prepare(
  `SELECT aid, raw_json FROM arena_mode_stats WHERE arena_mode = 'overall' AND best_arp IS NULL`,
).all();

const legacyStmt = db.prepare(`SELECT stats_json FROM mode_players WHERE mode = 'arena' AND aid = ?`);
const updateCurrent = db.prepare(`UPDATE arena_mode_stats SET best_arp = ? WHERE aid = ? AND arena_mode = 'overall'`);
const updateHistory = db.prepare(
  `UPDATE arena_mode_stats_history SET best_arp = ? WHERE aid = ? AND arena_mode = 'overall' AND best_arp IS NULL`,
);

let updated = 0;
let missing = 0;
for (const row of rows) {
  let arp = arpFromRawJson(row.raw_json);
  if (arp === null) {
    const legacy = legacyStmt.get(row.aid);
    if (legacy) arp = arpFromLegacyStats(legacy.stats_json);
  }
  if (arp === null) {
    missing += 1;
    continue;
  }
  updateCurrent.run(arp, row.aid);
  try {
    updateHistory.run(arp, row.aid);
  } catch {
    /* history table may not exist on very old DBs */
  }
  updated += 1;
}

console.log(`arena best_arp backfill: updated=${updated} missing=${missing} scanned=${rows.length}`);
db.close();
