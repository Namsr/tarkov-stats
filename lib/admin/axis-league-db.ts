import type { AxisLeagueResponse, AxisPlayer, AxisProfile } from "../axis-league";
import { AXIS_CHANNEL_ID, AXIS_REFRESH_MS } from "../axis-league.ts";
import type { AxisHistoryPage, AxisHistoryResponse } from "../axis-history";
import { AXIS_HISTORY_PAGE_SIZE } from "../axis-history.ts";
import { detectAxisSeasons, type AxisSeason } from "../axis-seasons.ts";
import { AxisKdaConflict, parseAxisKdaChanges, sameAxisKda, parseAxisRoundChange, sameAxisRoundScore, type AxisRoundScore, type AxisRoundChange, type AxisKda, type AxisKdaChange } from "../axis-kda.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- node:sqlite is loaded dynamically, as in the other admin stores.
type SqliteDatabase = any;
export function createAxisLeagueStore(db: SqliteDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS axis_match_rounds (
      match_number INTEGER PRIMARY KEY,
      team_a INTEGER NOT NULL CHECK(team_a BETWEEN 0 AND 9999),
      team_b INTEGER NOT NULL CHECK(team_b BETWEEN 0 AND 9999)
    );
    CREATE TABLE IF NOT EXISTS axis_kda_editors (google_sub TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS axis_match_kda (
      match_number INTEGER NOT NULL, discord_id TEXT NOT NULL,
      kills INTEGER NOT NULL CHECK(kills BETWEEN 0 AND 9999),
      deaths INTEGER NOT NULL CHECK(deaths BETWEEN 0 AND 9999),
      assists INTEGER NOT NULL CHECK(assists BETWEEN 0 AND 9999),
      PRIMARY KEY(match_number, discord_id)
    );
    CREATE TABLE IF NOT EXISTS axis_archive_matches (number INTEGER PRIMARY KEY, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS axis_archive_queue_time ON axis_archive_matches(
      json_extract(payload, '$.queueId'), json_extract(payload, '$.time'), number
    );
    CREATE TABLE IF NOT EXISTS axis_archive_seasons (id INTEGER PRIMARY KEY CHECK(id = 1), payload TEXT);
    INSERT OR IGNORE INTO axis_archive_seasons(id) VALUES(1);
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
  // Persist only the small season summary. HTTP reads parse at most one 25-match page.
  function updateSeasons(): AxisSeason[] {
    const matches = db.prepare("SELECT payload FROM axis_archive_matches ORDER BY number").all()
      .map((row: { payload: string }) => JSON.parse(row.payload));
    const seasons = detectAxisSeasons(matches);
    db.prepare("UPDATE axis_archive_seasons SET payload=? WHERE id=1").run(JSON.stringify(seasons));
    return seasons;
  }
  function readSeasons(): AxisSeason[] {
    const row = db.prepare("SELECT payload FROM axis_archive_seasons WHERE id=1").get();
    if (row.payload != null) return JSON.parse(row.payload);
    // One-time migration for an existing archive, coordinated across web and worker.
    db.exec("BEGIN IMMEDIATE");
    try {
      const saved = db.prepare("SELECT payload FROM axis_archive_seasons WHERE id=1").get();
      const seasons = saved.payload == null ? updateSeasons() : JSON.parse(saved.payload);
      db.exec("COMMIT");
      return seasons;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function profileLinks() {
    const links = new Map<string, AxisProfile>();
    for (const link of db.prepare("SELECT * FROM axis_league_profiles").all()) {
      links.set(link.discord_id, { aid: link.aid, mode: link.mode });
    }
    return links;
  }
  function decorateMatches(matches: AxisHistoryPage["matches"]) {
    const links = profileLinks();
    const stats = new Map<string, AxisKda>();
    const rounds = new Map<number, AxisRoundScore>();
    if (matches.length) {
      for (const row of db.prepare(`SELECT * FROM axis_match_kda WHERE match_number IN (${matches.map(() => "?").join(",")})`).all(...matches.map((match) => match.number))) {
        stats.set(`${row.match_number}:${row.discord_id}`, { kills: row.kills, deaths: row.deaths, assists: row.assists });
      }
      for (const row of db.prepare(`SELECT * FROM axis_match_rounds WHERE match_number IN (${matches.map(() => "?").join(",")})`).all(...matches.map((match) => match.number))) {
        rounds.set(row.match_number, { a: row.team_a, b: row.team_b });
      }
    }
    return matches.map((match) => ({ ...match, rounds: rounds.get(match.number) ?? null, teams: match.teams.map((team) => ({ ...team,
      players: team.players.map((player) => ({ ...player, profile: links.get(player.id) ?? null, kda: stats.get(`${match.number}:${player.id}`) ?? null })) })) }));
  }
  return {
    listKdaEditors(): string[] { return db.prepare("SELECT google_sub FROM axis_kda_editors ORDER BY google_sub").all().map((row: { google_sub: string }) => row.google_sub); },
    isKdaEditor(subject: string): boolean { return Boolean(db.prepare("SELECT 1 FROM axis_kda_editors WHERE google_sub=?").get(subject)); },
    setKdaEditor(subject: string, enabled: boolean) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(subject) || typeof enabled !== "boolean") throw new TypeError("Invalid editor identity");
      if (enabled) db.prepare("INSERT OR IGNORE INTO axis_kda_editors(google_sub) VALUES(?)").run(subject);
      else db.prepare("DELETE FROM axis_kda_editors WHERE google_sub=?").run(subject);
    },
    setMatchStats(matchNumber: number, input: AxisKdaChange[], roundInput?: AxisRoundChange) {
      if (!Number.isSafeInteger(matchNumber) || matchNumber <= 0) throw new TypeError("Invalid match number");
      const changes = Array.isArray(input) && input.length === 0 ? [] : parseAxisKdaChanges(input);
      const rounds = roundInput === undefined ? undefined : parseAxisRoundChange(roundInput);
      if (!changes.length && rounds === undefined) throw new TypeError("No match changes");
      const archived = db.prepare("SELECT payload FROM axis_archive_matches WHERE number=?").get(matchNumber);
      let match: AxisHistoryPage["matches"][number] | undefined = archived ? JSON.parse(archived.payload) : undefined;
      if (!match) {
        for (const row of db.prepare("SELECT payload FROM axis_history_pages WHERE payload IS NOT NULL").all()) {
          match = (JSON.parse(row.payload) as AxisHistoryPage).matches.find((entry) => entry.number === matchNumber);
          if (match) break;
        }
      }
      if (!match) throw new RangeError("Unknown match");
      if (rounds?.score && match.teams.length !== 2) throw new RangeError("Round score requires two teams");
      const participants = new Set(match.teams.flatMap((team) => team.players.map((player) => player.id)));
      if (changes.some((change) => !participants.has(change.discordId))) throw new RangeError("Player is not in this match");
      const read = db.prepare("SELECT kills,deaths,assists FROM axis_match_kda WHERE match_number=? AND discord_id=?");
      const save = db.prepare("INSERT INTO axis_match_kda(match_number,discord_id,kills,deaths,assists) VALUES(?,?,?,?,?) ON CONFLICT(match_number,discord_id) DO UPDATE SET kills=excluded.kills,deaths=excluded.deaths,assists=excluded.assists");
      const remove = db.prepare("DELETE FROM axis_match_kda WHERE match_number=? AND discord_id=?");
      db.exec("BEGIN IMMEDIATE");
      try {
        if (rounds !== undefined) {
          const existing = db.prepare("SELECT team_a AS a,team_b AS b FROM axis_match_rounds WHERE match_number=?").get(matchNumber) ?? null;
          if (!sameAxisRoundScore(existing, rounds.expected)) throw new AxisKdaConflict("Round score was changed by another editor");
        }
        for (const change of changes) {
          const existing = read.get(matchNumber, change.discordId) ?? null;
          if (!sameAxisKda(existing, change.expected)) throw new AxisKdaConflict("Match statistics were changed by another administrator");
        }
        for (const { discordId, kda } of changes) {
          if (kda) save.run(matchNumber, discordId, kda.kills, kda.deaths, kda.assists);
          else remove.run(matchNumber, discordId);
        }
        if (rounds !== undefined) {
          if (rounds.score) db.prepare("INSERT INTO axis_match_rounds(match_number,team_a,team_b) VALUES(?,?,?) ON CONFLICT(match_number) DO UPDATE SET team_a=excluded.team_a,team_b=excluded.team_b").run(matchNumber, rounds.score.a, rounds.score.b);
          else db.prepare("DELETE FROM axis_match_rounds WHERE match_number=?").run(matchNumber);
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return { players: changes.map(({ discordId, kda }) => ({ discordId, kda })), rounds: rounds?.score };
    },
    archiveState() { return db.prepare("SELECT * FROM axis_archive_state WHERE id = 1").get(); },
    restartArchiveImport() { db.prepare("UPDATE axis_archive_state SET next_page=2 WHERE id=1").run(); },
    claimArchiveRefresh(now = Date.now()): boolean {
      const interval = this.archiveState().complete ? AXIS_REFRESH_MS : 30_000;
      return db.prepare("UPDATE axis_archive_state SET attempted_at = ? WHERE id = 1 AND attempted_at <= ?").run(now, now - interval).changes === 1;
    },
    publishArchive(data: AxisHistoryPage, now = Date.now()) {
      const statement = db.prepare("INSERT INTO axis_archive_matches(number,payload) VALUES(?,?) ON CONFLICT(number) DO UPDATE SET payload=excluded.payload WHERE payload<>excluded.payload");
      db.exec("BEGIN IMMEDIATE");
      try {
        let changed = false;
        for (const match of data.matches) if (statement.run(match.number, JSON.stringify(match)).changes) changed = true;
        if (changed || db.prepare("SELECT payload FROM axis_archive_seasons WHERE id=1").get().payload == null) updateSeasons();
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
      const seasons = readSeasons();
      const selected = seasons.find((entry) => entry.id === season);
      if (season !== "all" && !selected) throw new RangeError("Unknown AXIS season");
      const where = selected ? " WHERE json_extract(payload, '$.queueId')=? AND json_extract(payload, '$.time')>=?" + (selected.endsAt == null ? "" : " AND json_extract(payload, '$.time')<?") : "";
      const parameters = selected ? [AXIS_CHANNEL_ID, selected.startsAt, ...(selected.endsAt == null ? [] : [selected.endsAt])] : [];
      const total = db.prepare("SELECT COUNT(*) AS n FROM axis_archive_matches" + where).get(...parameters).n;
      const matches = db.prepare("SELECT payload FROM axis_archive_matches" + where + " ORDER BY number DESC LIMIT ? OFFSET ?")
        .all(...parameters, AXIS_HISTORY_PAGE_SIZE, (page - 1) * AXIS_HISTORY_PAGE_SIZE).map((row: { payload: string }) => JSON.parse(row.payload));
      return { page, total, pages: Math.max(1, Math.ceil(total / AXIS_HISTORY_PAGE_SIZE)), seasons: state.complete ? seasons : seasons.filter((entry) => entry.current), season,
        matches: decorateMatches(matches),
        archiveComplete: Boolean(state.complete), updatedAt: state.updated_at, available: state.updated_at != null,
        stale: Boolean(state.last_error) || state.updated_at != null && now - state.updated_at > AXIS_REFRESH_MS * 2 };
    },
    read(now = Date.now()): AxisLeagueResponse {
      const row = db.prepare("SELECT * FROM axis_league_snapshot WHERE id = 1").get();
      const players: AxisPlayer[] = row.payload == null ? [] : JSON.parse(row.payload);
      const links = profileLinks();
      const currentSeason = readSeasons()[0];
      const games = this.archiveState().updated_at == null ? null : db.prepare("SELECT COUNT(*) AS n FROM axis_archive_matches WHERE json_extract(payload, '$.queueId')=? AND json_extract(payload, '$.time')>=? AND (json_extract(payload, '$.winner')>=0 OR json_extract(payload, '$.winner')=-2)")
        .get(AXIS_CHANNEL_ID, currentSeason.startsAt).n;
      return { currentSeason: { startsAt: currentSeason.startsAt, inferred: currentSeason.inferred, games }, players: players.map((player) => ({ ...player, profile: links.get(player.id) ?? null })),
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
      return { ...data, matches: decorateMatches(data.matches),
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
