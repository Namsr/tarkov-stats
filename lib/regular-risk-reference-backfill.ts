import type { DatabaseSync } from "node:sqlite";
import type { ParsedPlayerStats } from "../types/tarkov.ts";
import { storedRegularRiskInputs } from "./regular-risk-score.ts";

/** Populate derived comparison columns from the matching saved profile version. */
export function backfillRegularRiskReferences(players: DatabaseSync, snapshots: DatabaseSync): number {
  const columns = players.prepare("PRAGMA table_info(players)").all();
  if (!columns.some((column) => column.name === "risk_parser_version")) return 0;
  if (!snapshots.prepare("SELECT 1 FROM sqlite_master WHERE name = 'progression_snapshots'").get()) return 0;
  const candidates = players.prepare(`SELECT aid, profile_updated_at FROM players p
    WHERE risk_raids IS NULL AND COALESCE(risk_parser_version, 0) < 2 AND profile_updated_at > 0
      AND NOT EXISTS (SELECT 1 FROM excluded_players e WHERE e.aid = p.aid)`).all();
  const snapshot = snapshots.prepare(`SELECT stats_json FROM progression_snapshots
    WHERE mode = 'regular' AND cycle_id = 'persistent' AND aid = ? AND upstream_updated_at = ?
    ORDER BY captured_at DESC, id DESC LIMIT 1`);
  const update = players.prepare(`UPDATE players SET risk_raids = ?, risk_deaths = ?, risk_survived = ?,
    risk_kills = ?, risk_killed_pmc = ?, risk_streak = ?, risk_prestige = ?, risk_parser_version = ?
    WHERE aid = ? AND profile_updated_at = ? AND risk_raids IS NULL AND COALESCE(risk_parser_version, 0) < 2`);
  let updated = 0;
  for (let offset = 0; offset < candidates.length; offset += 500) {
    players.exec("SAVEPOINT backfill_regular_risk");
    try {
      for (const row of candidates.slice(offset, offset + 500)) {
        const saved = snapshot.get(row.aid, row.profile_updated_at);
        if (!saved?.stats_json) continue;
        let stats: Partial<ParsedPlayerStats>;
        try { stats = JSON.parse(String(saved.stats_json)); } catch { continue; }
        if (!stats || typeof stats !== "object" || Array.isArray(stats) || stats.profileUpdatedAt !== row.profile_updated_at) continue;
        const raw = storedRegularRiskInputs(stats);
        if (raw.raids === null) continue;
        updated += Number(update.run(raw.raids, raw.deaths, raw.survived, raw.kills, raw.killedPmc,
          raw.streak, raw.prestige, stats.pvpStatsParserVersion ?? 0, row.aid, row.profile_updated_at).changes);
      }
      players.exec("RELEASE backfill_regular_risk");
    } catch (error) {
      players.exec("ROLLBACK TO backfill_regular_risk; RELEASE backfill_regular_risk");
      throw error;
    }
  }
  return updated;
}
