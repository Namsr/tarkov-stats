import type { AxisLeagueResponse, AxisPlayer, AxisProfile } from "../axis-league";
import { AXIS_REFRESH_MS } from "../axis-league.ts";
import type { AxisHistoryPage, AxisHistoryResponse } from "../axis-history";
import { AXIS_HISTORY_PAGE_SIZE } from "../axis-history.ts";
import { detectAxisSeasons, axisSeasonMatches } from "../axis-seasons.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- node:sqlite is loaded dynamically, as in the other admin stores.
type SqliteDatabase = any;
export function createAxisLeagueStore(db: SqliteDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS axis_archive_matches (number INTEGER PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS axis_archive_state (
      id INTEGER PRIMARY KEY CHECK(id = 1), next_page INTEGER NOT NULL DEFAULT 2,
      complete INTEGER NOT NULL DEFAULT 0, updated_at INTEGER, attempted_at INTEGER NOT NULL DEFAULT 0,
      last_error INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO axis_archive_state(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS axis_league_snapshot (
      id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT, updated_at INTEGER,
      attempted_at INTEGER NOT NULL DEFAULT 0, last_error INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO axis_league_snapshot(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS axis_history_pages (
      page INTEGER PRIMARY KEY, payload TEXT, updated_at INTEGER,
      attempted_at INTEGER NOT NULL DEFAULT 0, last_error INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS axis_league_profiles (
      discord_id TEXT PRIMARY KEY, aid INTEGER NOT NULL, mode TEXT NOT NULL,
      UNIQUE(aid, mode)
    );
  `);
  function profileLinks() {
    const links = new Map<string, AxisProfile>();
    for (const link of db.prepare("SELECT * FROM axis_league_profiles").all()) {
      links.set(link.discord_id, { aid: link.aid, mode: link.mode });
    }
    return links;
  }
  return {
    archiveState() { return db.prepare("SELECT * FROM axis_archive_state WHERE id = 1").get(); },
    claimArchiveRefresh(now = Date.now()): boolean {
      const interval = this.archiveState().complete ? AXIS_REFRESH_MS : 30_000;
      return db.prepare("UPDATE axis_archive_state SET attempted_at = ? WHERE id = 1 AND attempted_at <= ?").run(now, now - interval).changes === 1;
    },
    publishArchive(data: AxisHistoryPage, now = Date.now()) {
      const statement = db.prepare("INSERT INTO axis_archive_matches(number,payload) VALUES(?,?) ON CONFLICT(number) DO UPDATE SET payload=excluded.payload");
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const match of data.matches) statement.run(match.number, JSON.stringify(match));
        // A page can shift while the archive is imported. Completeness requires every record.
        const count = db.prepare("SELECT COUNT(*) AS n FROM axis_archive_matches").get().n;
        const nextPage = data.page === 1 ? this.archiveState().next_page : data.page + 1;
        db.prepare("UPDATE axis_archive_state SET updated_at=?,last_error=0,complete=?,next_page=? WHERE id=1")
          .run(now, Number(count >= data.total), nextPage > data.pages ? 2 : nextPage);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    failArchiveRefresh() { db.prepare("UPDATE axis_archive_state SET last_error=1 WHERE id=1").run(); },
    readSeasonHistory(page: number, season: string, now = Date.now()): AxisHistoryResponse {
      const state = this.archiveState();
      const all: AxisHistoryPage["matches"] = db.prepare("SELECT payload FROM axis_archive_matches ORDER BY number DESC").all().map((row: {payload: string}) => JSON.parse(row.payload));
      const seasons = detectAxisSeasons(all);
      const selected = seasons.find((entry) => entry.id === season);
      if (season !== "all" && !selected) throw new RangeError("Unknown AXIS season");
      const matches = selected ? axisSeasonMatches(all, selected) : all;
      const links = profileLinks();
      return { page, total: matches.length, pages: Math.max(1, Math.ceil(matches.length / AXIS_HISTORY_PAGE_SIZE)), seasons: state.complete ? seasons : seasons.filter((entry) => entry.current), season,
        matches: matches.slice((page - 1) * AXIS_HISTORY_PAGE_SIZE, page * AXIS_HISTORY_PAGE_SIZE).map((match) => ({ ...match, teams: match.teams.map((team) => ({ ...team,
          players: team.players.map((player) => ({ ...player, profile: links.get(player.id) ?? null })) })) })),
        archiveComplete: Boolean(state.complete), updatedAt: state.updated_at, available: state.updated_at != null,
        stale: Boolean(state.last_error) || state.updated_at != null && now - state.updated_at > AXIS_REFRESH_MS * 2 };
    },
    read(now = Date.now()): AxisLeagueResponse {
      const row = db.prepare("SELECT * FROM axis_league_snapshot WHERE id = 1").get();
      const players: AxisPlayer[] = row.payload == null ? [] : JSON.parse(row.payload);
      const links = profileLinks();
      const archive: AxisHistoryPage["matches"] = db.prepare("SELECT payload FROM axis_archive_matches ORDER BY number").all().map((row: {payload: string}) => JSON.parse(row.payload));
      const currentSeason = detectAxisSeasons(archive)[0];
      return { currentSeason: { startsAt: currentSeason.startsAt, inferred: currentSeason.inferred }, players: players.map((player) => ({ ...player, profile: links.get(player.id) ?? null })),
        updatedAt: row.updated_at, available: row.payload != null,
        stale: Boolean(row.last_error) || (row.updated_at != null && now - row.updated_at > AXIS_REFRESH_MS * 2) };
    },
    // Atomic across the web process and supervised worker; requests cannot fan out into upstream calls.
    claimRefresh(now = Date.now()): boolean {
      return db.prepare("UPDATE axis_league_snapshot SET attempted_at = ? WHERE id = 1 AND attempted_at <= ?")
        .run(now, now - AXIS_REFRESH_MS).changes === 1;
    },
    publish(players: AxisPlayer[], now = Date.now()) {
      db.prepare("UPDATE axis_league_snapshot SET payload = ?, updated_at = ?, last_error = 0 WHERE id = 1")
        .run(JSON.stringify(players.map((player) => ({ ...player, profile: null }))), now);
    },
    failRefresh() { db.prepare("UPDATE axis_league_snapshot SET last_error = 1 WHERE id = 1").run(); },
    readHistory(page: number, now = Date.now()): AxisHistoryResponse {
      const row = db.prepare("SELECT * FROM axis_history_pages WHERE page = ?").get(page);
      const data: AxisHistoryPage = row?.payload == null ? { matches: [], page, pages: 1, total: 0 } : JSON.parse(row.payload);
      const links = profileLinks();
      return { ...data, matches: data.matches.map((match) => ({ ...match, teams: match.teams.map((team) => ({ ...team,
        players: team.players.map((player) => ({ ...player, profile: links.get(player.id) ?? null })) })) })),
        updatedAt: row?.updated_at ?? null, available: row?.payload != null,
        stale: Boolean(row?.last_error) || (row?.updated_at != null && now - row.updated_at > AXIS_REFRESH_MS * 2) };
    },
    claimHistoryRefresh(page: number, now = Date.now()): boolean {
      db.prepare("INSERT OR IGNORE INTO axis_history_pages(page) VALUES(?)").run(page);
      return db.prepare("UPDATE axis_history_pages SET attempted_at = ? WHERE page = ? AND attempted_at <= ?")
        .run(now, page, now - AXIS_REFRESH_MS).changes === 1;
    },
    publishHistory(data: AxisHistoryPage, now = Date.now()) {
      db.prepare(`INSERT INTO axis_history_pages(page, payload, updated_at) VALUES(?, ?, ?)
        ON CONFLICT(page) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at, last_error = 0`)
        .run(data.page, JSON.stringify(data), now);
    },
    failHistoryRefresh(page: number) { db.prepare("UPDATE axis_history_pages SET last_error = 1 WHERE page = ?").run(page); },
    setProfile(discordId: string, profile: AxisProfile | null) {
      if (!/^\d{1,20}$/.test(discordId)) throw new TypeError("Invalid Discord ID");
      if (!this.read().players.some((player) => player.id === discordId)) throw new RangeError("Player is not in the leaderboard");
      if (profile == null) {
        db.prepare("DELETE FROM axis_league_profiles WHERE discord_id = ?").run(discordId);
        return;
      }
      if (!Number.isSafeInteger(profile.aid) || profile.aid <= 0 || !["regular", "pve", "arena", "seasonal"].includes(profile.mode)) {
        throw new TypeError("Invalid profile");
      }
      const duplicate = db.prepare("SELECT discord_id FROM axis_league_profiles WHERE aid = ? AND mode = ? AND discord_id != ?")
        .get(profile.aid, profile.mode, discordId);
      if (duplicate) throw new RangeError("Profile is already linked to another player");
      db.prepare(`INSERT INTO axis_league_profiles(discord_id, aid, mode) VALUES(?, ?, ?)
        ON CONFLICT(discord_id) DO UPDATE SET aid = excluded.aid, mode = excluded.mode`).run(discordId, profile.aid, profile.mode);
    },
  };
}
export type AxisLeagueStore = ReturnType<typeof createAxisLeagueStore>;

let storePromise: Promise<AxisLeagueStore> | null = null;
let activePath = "";
export async function getAxisLeagueStore(): Promise<AxisLeagueStore> {
  const targetPath = process.env.ADMIN_ANALYTICS_SQLITE_PATH || "/data/admin-analytics.db";
  if (!storePromise || activePath !== targetPath) {
    activePath = targetPath;
    const opening = (async () => {
      const { mkdirSync } = await import("node:fs");
      const { dirname } = await import("node:path");
      const sqlite = await import("node:sqlite" as string);
      mkdirSync(dirname(targetPath), { recursive: true });
      const db = new sqlite.DatabaseSync(targetPath);
      try {
        db.exec("PRAGMA busy_timeout = 5000;");
        return createAxisLeagueStore(db);
      } catch (error) { db.close(); throw error; }
    })();
    storePromise = opening;
    opening.catch(() => { if (storePromise === opening) storePromise = null; });
  }
  return storePromise;
}
