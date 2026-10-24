import { AXIS_PHOTO_MAX_BYTES, AXIS_PHOTO_MAX_PIXELS, type AxisMatchPhoto, type AxisStoredPhoto, type AxisPhotoChange } from "../axis-match-photo.ts";
import type { AxisLeagueResponse, AxisPlayer, AxisProfile, AxisRecentMatch } from "../axis-league";
import { AXIS_CHANNEL_ID, AXIS_REFRESH_MS } from "../axis-league.ts";
import type { AxisHistoryPage, AxisHistoryResponse, AxisHistorySummary, AxisMatchEdit } from "../axis-history";
import { AXIS_HISTORY_PAGE_SIZE, advanceAxisArchiveState } from "../axis-history.ts";
import { detectAxisSeasons, type AxisSeason } from "../axis-seasons.ts";
import { AxisKdaConflict, parseAxisKdaChanges, sameAxisKda, parseAxisRoundChange, sameAxisRoundScore, type AxisRoundScore, type AxisRoundChange, type AxisKda, type AxisKdaChange } from "../axis-kda.ts";
import { axisLeagueAverages, buildAxisPlayerSummary, AXIS_PLAYER_PAGE_SIZE, type AxisIdentity, type AxisPlayerSummary, type AxisPlayerProfileResponse } from "../axis-player-profile.ts";
import { AXIS_PREDICTION_VERSION, buildAxisWinProbabilities, type AxisWinProbability } from "../axis-win-probability.ts";
import { axisMatchRosterFingerprintForMatch, type AxisMatchConflict, type AxisMatchReview, type AxisMatchReviewView, type AxisMatchSubmissionReview, type AxisUploadRole } from "../axis-match-submission.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- node:sqlite is loaded dynamically, as in the other admin stores.
type SqliteDatabase = any;
type AxisReviewSubmissionRow = {
  match_number: number;
  photo_revision: string;
  recognized_names: string;
  unmatched_names: string;
  missing_discord_ids: string;
  conflicts: string;
  round_conflict: string | null;
  google_sub: string;
  uploaded_at: number;
};
type AxisReviewPrimaryPhotoRow = { match_number: number; revision: string };
type AxisReviewKdaRow = { match_number: number; discord_id: string; kills: number; deaths: number; assists: number };
// KDA and round scores come from their own tables, never from archive payloads.
function predictionInput(match: AxisHistoryPage["matches"][number]): string {
  return JSON.stringify([match.time, match.queueId ?? `unknown:${match.queue ?? ""}`, match.maps, match.winner,
    match.teams.map(team => team.players.map(player => [player.id, player.mmr, player.change]))]);
}
export function createAxisLeagueStore(db: SqliteDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS axis_match_photos (
      match_number INTEGER PRIMARY KEY, revision TEXT NOT NULL,
      width INTEGER NOT NULL, height INTEGER NOT NULL, data BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS axis_match_rounds (
      match_number INTEGER PRIMARY KEY,
      team_a INTEGER NOT NULL CHECK(team_a BETWEEN 0 AND 9999),
      team_b INTEGER NOT NULL CHECK(team_b BETWEEN 0 AND 9999)
    );
    CREATE TABLE IF NOT EXISTS axis_kda_editors (google_sub TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS axis_match_roles (
      google_sub TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK(role IN ('player','moderator'))
    );
    CREATE TABLE IF NOT EXISTS axis_match_submissions (
      match_number INTEGER NOT NULL,
      photo_revision TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      data BLOB NOT NULL,
      recognized_names TEXT NOT NULL,
      unmatched_names TEXT NOT NULL,
      missing_discord_ids TEXT NOT NULL,
      conflicts TEXT NOT NULL,
      round_conflict TEXT,
      google_sub TEXT NOT NULL,
      uploaded_at INTEGER NOT NULL,
      PRIMARY KEY(match_number, photo_revision)
    );
    CREATE INDEX IF NOT EXISTS axis_match_submissions_time ON axis_match_submissions(uploaded_at DESC,match_number);
    CREATE TABLE IF NOT EXISTS axis_google_accounts (google_sub TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE IF NOT EXISTS axis_match_edits (
      match_number INTEGER PRIMARY KEY, google_sub TEXT NOT NULL, name TEXT, edited_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS axis_match_kda (
      match_number INTEGER NOT NULL, discord_id TEXT NOT NULL,
      kills INTEGER NOT NULL CHECK(kills BETWEEN 0 AND 9999),
      deaths INTEGER NOT NULL CHECK(deaths BETWEEN 0 AND 9999),
      assists INTEGER NOT NULL CHECK(assists BETWEEN 0 AND 9999),
      PRIMARY KEY(match_number, discord_id)
    );
    CREATE TABLE IF NOT EXISTS axis_archive_matches (number INTEGER PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS axis_match_predictions (number INTEGER PRIMARY KEY, a REAL NOT NULL, b REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS axis_prediction_state (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT -1);
    INSERT OR IGNORE INTO axis_prediction_state(id) VALUES(1);
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
  function withImmediateTransaction<T>(work: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }
  // Invalidate only for match/KDA changes, including writes by another worker or an older process.
  db.exec("CREATE TABLE IF NOT EXISTS axis_preview_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0); INSERT OR IGNORE INTO axis_preview_state(id) VALUES(1)");
  for (const table of ["axis_match_kda", "axis_archive_matches", "axis_match_rounds"]) {
    for (const event of ["INSERT", "UPDATE", "DELETE"]) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS preview_${table}_${event} AFTER ${event} ON ${table}
        BEGIN UPDATE axis_preview_state SET revision=revision+1 WHERE id=1; END`);
    }
  }
  db.exec("CREATE TABLE IF NOT EXISTS axis_player_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0); INSERT OR IGNORE INTO axis_player_state(id) VALUES(1)");
  for (const table of ["axis_match_kda", "axis_archive_matches", "axis_league_profiles", "axis_league_snapshot"]) {
    for (const event of ["INSERT", "UPDATE", "DELETE"]) {
      const contentUpdate = table === "axis_league_snapshot" && event === "UPDATE";
      db.exec(`CREATE TRIGGER IF NOT EXISTS player_${table}_${event} AFTER ${contentUpdate ? "UPDATE OF payload" : event} ON ${table}
        ${contentUpdate ? "WHEN NEW.payload IS NOT OLD.payload" : ""}
        BEGIN UPDATE axis_player_state SET revision=revision+1 WHERE id=1; END`);
    }
  }
  const playerVersion = db.prepare("SELECT revision FROM axis_player_state WHERE id=1");
  // Profile reads use an indexed membership lookup, not a scan of every match's JSON.
  db.exec(`CREATE TABLE IF NOT EXISTS axis_match_participants (
    match_number INTEGER NOT NULL, discord_id TEXT NOT NULL, team_index INTEGER NOT NULL,
    PRIMARY KEY(match_number,discord_id)
  );
  CREATE INDEX IF NOT EXISTS axis_participant_player ON axis_match_participants(discord_id,match_number DESC);
  CREATE INDEX IF NOT EXISTS axis_kda_player ON axis_match_kda(discord_id,match_number);
  CREATE TABLE IF NOT EXISTS axis_participant_migration (id INTEGER PRIMARY KEY CHECK(id=1), ready INTEGER NOT NULL DEFAULT 0);
  INSERT OR IGNORE INTO axis_participant_migration(id) VALUES(1);
  CREATE TRIGGER IF NOT EXISTS axis_participant_insert AFTER INSERT ON axis_archive_matches BEGIN
    INSERT OR IGNORE INTO axis_match_participants SELECT NEW.number,json_extract(player.value,'$.id'),CAST(team.key AS INTEGER)
      FROM json_each(NEW.payload,'$.teams') team,json_each(team.value,'$.players') player;
  END;
  CREATE TRIGGER IF NOT EXISTS axis_participant_update AFTER UPDATE ON axis_archive_matches BEGIN
    DELETE FROM axis_match_participants WHERE match_number=OLD.number;
    INSERT OR IGNORE INTO axis_match_participants SELECT NEW.number,json_extract(player.value,'$.id'),CAST(team.key AS INTEGER)
      FROM json_each(NEW.payload,'$.teams') team,json_each(team.value,'$.players') player;
  END;
  CREATE TRIGGER IF NOT EXISTS axis_participant_delete AFTER DELETE ON axis_archive_matches BEGIN
    DELETE FROM axis_match_participants WHERE match_number=OLD.number;
  END;`);
  // Called only by the worker/import transaction, never from a profile read.
  function backfillParticipants() {
    if (!db.prepare("SELECT ready FROM axis_participant_migration WHERE id=1").get().ready) {
      db.exec(`INSERT OR IGNORE INTO axis_match_participants
        SELECT m.number,json_extract(player.value,'$.id'),CAST(team.key AS INTEGER)
        FROM axis_archive_matches m,json_each(m.payload,'$.teams') team,json_each(team.value,'$.players') player;
        UPDATE axis_participant_migration SET ready=1 WHERE id=1`);
    }
  }
  let parsedSnapshot: { payload: string | null; players: AxisPlayer[] } | null = null;
  function readSnapshotPlayers(): AxisPlayer[] {
    const payload = db.prepare("SELECT payload FROM axis_league_snapshot WHERE id=1").get().payload as string | null;
    if (parsedSnapshot?.payload === payload) return parsedSnapshot.players;
    const players = payload == null ? [] : JSON.parse(payload) as AxisPlayer[];
    parsedSnapshot = { payload, players };
    return players;
  }
  const playerSummaries = new Map<string, { version: string; summary: AxisPlayerSummary }>();
  const periodAverages = new Map<string, { version: number; averages: AxisPlayerSummary["averages"]; kda: number | null; recentKda: number | null }>();
  let previewCache: {
    version: string;
    players: Map<string, { combatStats: NonNullable<AxisPlayer["combatStats"]>; recentMatches: AxisRecentMatch[] }>;
    averageKda: number | null;
    games: number | null;
  } | null = null;
  let historySummaryRevision = "";
  const historySummaries = new Map<string, AxisHistorySummary>();
  const previewVersion = db.prepare("SELECT revision FROM axis_preview_state WHERE id=1");
  const historyVersion = db.prepare(`SELECT s.revision AS matches_revision,p.version,p.revision AS prediction_revision
    FROM axis_preview_state s JOIN axis_prediction_state p ON p.id=s.id WHERE s.id=1`);
  function readPreviews(startsAt: number, archive: { complete: number; updated_at: number | null }) {
    const version = `${startsAt}:${previewVersion.get().revision}:${archive.complete}:${archive.updated_at == null}`;
    if (previewCache?.version === version) return previewCache;
    const players = new Map<string, { combatStats: NonNullable<AxisPlayer["combatStats"]>; recentMatches: AxisRecentMatch[] }>();
    let averageKda: number | null = null;
    const rows = db.prepare(`
      WITH recorded AS (
        SELECT k.*, m.number, json_extract(m.payload, '$.time') AS played_at,
          json_extract(m.payload, '$.winner') AS winner,
          (SELECT CAST(team.key AS INTEGER)
            FROM json_each(m.payload, '$.teams') team, json_each(team.value, '$.players') player
            WHERE json_extract(player.value, '$.id')=k.discord_id LIMIT 1) AS team_index
        FROM axis_match_kda k JOIN axis_archive_matches m ON m.number=k.match_number
        WHERE json_extract(m.payload, '$.queueId')=? AND json_extract(m.payload, '$.time')>=?
          AND (json_extract(m.payload, '$.winner')>=0 OR json_extract(m.payload, '$.winner')=-2)
      ), ranked AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY discord_id ORDER BY played_at DESC,number DESC) AS recent_rank,
          SUM(kills) OVER (PARTITION BY discord_id) AS total_kills,
          SUM(deaths) OVER (PARTITION BY discord_id) AS total_deaths,
          SUM(assists) OVER (PARTITION BY discord_id) AS total_assists,
          COUNT(*) OVER (PARTITION BY discord_id) AS total_matches,
          AVG((kills+assists)*1.0/MAX(deaths,1)) OVER () AS league_average
        FROM recorded WHERE team_index IS NOT NULL
      ) SELECT * FROM ranked WHERE recent_rank<=6 ORDER BY discord_id,played_at,number
    `).all(AXIS_CHANNEL_ID, startsAt);
    for (const row of rows) {
      averageKda = row.league_average;
      let player = players.get(row.discord_id);
      if (!player) {
        player = { combatStats: { kills: row.total_kills, deaths: row.total_deaths, assists: row.total_assists, matches: row.total_matches }, recentMatches: [] };
        players.set(row.discord_id, player);
      }
      player.recentMatches.push({ number: row.number, time: row.played_at,
        won: row.winner === -2 ? null : row.winner === row.team_index,
        kills: row.kills, deaths: row.deaths, assists: row.assists });
    }
    // Cache the season count too: its JSON scan must not repeat for every page visitor.
    const knownSeason = archive.complete || db.prepare("SELECT 1 FROM (SELECT payload FROM axis_archive_matches ORDER BY number DESC LIMIT ?) WHERE json_extract(payload, '$.queueId')=? AND json_extract(payload, '$.time')<? LIMIT 1")
      .get(AXIS_HISTORY_PAGE_SIZE, AXIS_CHANNEL_ID, startsAt);
    const games = archive.updated_at == null || !knownSeason ? null : db.prepare("SELECT COUNT(*) AS n FROM axis_archive_matches WHERE json_extract(payload, '$.queueId')=? AND json_extract(payload, '$.time')>=? AND (json_extract(payload, '$.winner')>=0 OR json_extract(payload, '$.winner')=-2)")
      .get(AXIS_CHANNEL_ID, startsAt).n;
    previewCache = { version, players, averageKda, games };
    return previewCache;
  }
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
  // Run inside the import/edit transaction. HTTP reads fetch only the requested page's
  // saved probabilities, and all processes see the same atomic model revision.
  function rebuildPredictions(unchangedSince?: number) {
    const revision = previewVersion.get().revision as number;
    const saved = db.prepare("SELECT version,revision FROM axis_prediction_state WHERE id=1").get();
    if (saved.version === AXIS_PREDICTION_VERSION && saved.revision === revision) return;
    // Names, avatars and team labels do not change any model input. Only advance
    // an already-current model; an older worker's unseen changes still force replay.
    if (saved.version === AXIS_PREDICTION_VERSION && saved.revision === unchangedSince) {
      db.prepare("UPDATE axis_prediction_state SET revision=? WHERE id=1").run(revision);
      return;
    }
    const stats = new Map<string, AxisKda>();
    for (const row of db.prepare("SELECT * FROM axis_match_kda").all()) {
      stats.set(`${row.match_number}:${row.discord_id}`, { kills: row.kills, deaths: row.deaths, assists: row.assists });
    }
    const rounds = new Map<number, AxisRoundScore>();
    for (const row of db.prepare("SELECT * FROM axis_match_rounds").all()) rounds.set(row.match_number, { a: row.team_a, b: row.team_b });
    const matches = db.prepare("SELECT payload FROM axis_archive_matches ORDER BY number").all().map((row: { payload: string }) => {
      const match = JSON.parse(row.payload) as AxisHistoryPage["matches"][number];
      return { ...match, rounds: rounds.get(match.number) ?? null, teams: match.teams.map(team => ({ ...team,
        players: team.players.map(player => ({ ...player, kda: stats.get(`${match.number}:${player.id}`) ?? null })) })) };
    });
    const predictions = buildAxisWinProbabilities(matches);
    const remove = db.prepare("DELETE FROM axis_match_predictions WHERE number=?");
    for (const row of db.prepare("SELECT number FROM axis_match_predictions").all()) {
      if (!predictions.has(row.number)) remove.run(row.number);
    }
    // Appending a game does not rewrite thousands of unchanged historical forecasts.
    const save = db.prepare(`INSERT INTO axis_match_predictions(number,a,b) VALUES(?,?,?)
      ON CONFLICT(number) DO UPDATE SET a=excluded.a,b=excluded.b WHERE a<>excluded.a OR b<>excluded.b`);
    for (const [number, probability] of predictions) save.run(number, probability.a, probability.b);
    db.prepare("UPDATE axis_prediction_state SET version=?,revision=? WHERE id=1").run(AXIS_PREDICTION_VERSION, revision);
  }
  function decorateMatches(matches: AxisHistoryPage["matches"]) {
    const links = profileLinks();
    const stats = new Map<string, AxisKda>();
    const rounds = new Map<number, AxisRoundScore>();
    const edits = new Map<number, AxisMatchEdit>();
    const probabilities = new Map<number, AxisWinProbability>();
    if (matches.length) {
      for (const row of db.prepare(`SELECT number,a,b FROM axis_match_predictions WHERE number IN (${matches.map(() => "?").join(",")})`).all(...matches.map(match => match.number))) {
        probabilities.set(row.number, { a: row.a, b: row.b });
      }
      for (const row of db.prepare(`SELECT * FROM axis_match_kda WHERE match_number IN (${matches.map(() => "?").join(",")})`).all(...matches.map((match) => match.number))) {
        stats.set(`${row.match_number}:${row.discord_id}`, { kills: row.kills, deaths: row.deaths, assists: row.assists });
      }
      for (const row of db.prepare(`SELECT * FROM axis_match_rounds WHERE match_number IN (${matches.map(() => "?").join(",")})`).all(...matches.map((match) => match.number))) {
        rounds.set(row.match_number, { a: row.team_a, b: row.team_b });
      }
    }
    if (matches.length) {
      for (const row of db.prepare(`SELECT match_number,name,edited_at FROM axis_match_edits WHERE match_number IN (${matches.map(() => "?").join(",")})`).all(...matches.map((match) => match.number))) {
        edits.set(row.match_number, { name: row.name, at: row.edited_at });
      }
    }
    return matches.map((match) => ({ ...match, winProbability: probabilities.get(match.number) ?? buildAxisWinProbabilities([match]).get(match.number) ?? null,
      edited: edits.get(match.number) ?? null, rounds: rounds.get(match.number) ?? null, teams: match.teams.map((team) => ({ ...team,
      players: team.players.map((player) => ({ ...player, profile: links.get(player.id) ?? null, kda: stats.get(`${match.number}:${player.id}`) ?? null })) })) }));
  }
  function buildAxisMatchReview(
    matchNumber: number,
    rows: readonly AxisReviewSubmissionRow[],
    primaryRevision: string | null,
    match: AxisHistoryPage["matches"][number] | null,
    recorded: ReadonlyMap<string, AxisKda>,
  ): AxisMatchReviewView | null {
    // Evidence without an archived roster cannot be safely attributed.
    if (!match) return null;
    const missingPlayers = match.teams.flatMap((team) => team.players.filter((player) => !recorded.has(player.id)));
    const submissions: AxisMatchSubmissionReview[] = rows.map((row) => ({
      matchNumber,
      photoRevision: row.photo_revision,
      recognizedNames: JSON.parse(row.recognized_names) as string[],
      unmatchedNames: JSON.parse(row.unmatched_names) as string[],
      missingDiscordIds: JSON.parse(row.missing_discord_ids) as string[],
      conflicts: JSON.parse(row.conflicts) as AxisMatchConflict[],
      roundConflict: row.round_conflict == null ? null : JSON.parse(row.round_conflict) as AxisMatchSubmissionReview["roundConflict"],
      uploadedBy: row.google_sub,
      uploadedAt: row.uploaded_at,
    }));
    // Photos from before the evidence table still need a synthetic review row.
    if (primaryRevision && !submissions.some((submission) => submission.photoRevision === primaryRevision)) {
      submissions.push({
        matchNumber,
        photoRevision: primaryRevision,
        recognizedNames: [],
        unmatchedNames: [],
        missingDiscordIds: missingPlayers.map((player) => player.id),
        uploadedBy: "legacy",
        uploadedAt: 0,
        conflicts: [],
        roundConflict: null,
      });
    }
    const latest = submissions[0] ?? null;
    return {
      matchNumber,
      photoRevision: latest?.photoRevision ?? "",
      recognizedNames: latest?.recognizedNames ?? [],
      unmatchedNames: [...new Set(submissions.flatMap((entry) => entry.unmatchedNames))],
      missingDiscordIds: missingPlayers.map((player) => player.id),
      uploadedBy: latest?.uploadedBy ?? "",
      uploadedAt: latest?.uploadedAt ?? 0,
      missingStats: missingPlayers.map((player) => player.name),
      unreadableNames: submissions.reduce((count, entry) => count + entry.unmatchedNames.filter((name) => !name.trim()).length, 0),
      nicknameMismatches: [...new Set(submissions.flatMap((entry) => entry.unmatchedNames.filter((name) => name.trim())))],
      conflicts: submissions.flatMap((entry) => entry.conflicts),
      roundConflict: submissions.find((entry) => entry.roundConflict)?.roundConflict ?? null,
      submissions,
    };
  }
  function readAxisMatchReviewsInternal(numbers: readonly number[]): AxisMatchReviewView[] {
    if (!Array.isArray(numbers) || numbers.length > 25 || numbers.some((number) => !Number.isSafeInteger(number) || number <= 0)) {
      throw new TypeError("Invalid match numbers");
    }
    const uniqueNumbers = [...new Set(numbers)];
    if (!uniqueNumbers.length) return [];
    const placeholders = uniqueNumbers.map(() => "?").join(",");
    const submissionRows = db.prepare(`SELECT match_number,photo_revision,recognized_names,unmatched_names,missing_discord_ids,
        conflicts,round_conflict,google_sub,uploaded_at FROM axis_match_submissions
        WHERE match_number IN (${placeholders}) ORDER BY match_number,uploaded_at DESC,photo_revision DESC`).all(...uniqueNumbers) as AxisReviewSubmissionRow[];
    const primaryRows = db.prepare(`SELECT match_number,revision FROM axis_match_photos WHERE match_number IN (${placeholders})`).all(...uniqueNumbers) as AxisReviewPrimaryPhotoRow[];
    const archiveRows = db.prepare(`SELECT number,payload FROM axis_archive_matches WHERE number IN (${placeholders})`).all(...uniqueNumbers) as { number: number; payload: string }[];
    const kdaRows = db.prepare(`SELECT match_number,discord_id,kills,deaths,assists FROM axis_match_kda WHERE match_number IN (${placeholders})`).all(...uniqueNumbers) as AxisReviewKdaRow[];
    const submissionsByMatch = new Map<number, AxisReviewSubmissionRow[]>();
    for (const row of submissionRows) {
      const entries = submissionsByMatch.get(row.match_number) ?? [];
      entries.push(row);
      submissionsByMatch.set(row.match_number, entries);
    }
    const primaryByMatch = new Map(primaryRows.map((row) => [row.match_number, row.revision]));
    const archiveByMatch = new Map(archiveRows.map((row) => [row.number, JSON.parse(row.payload) as AxisHistoryPage["matches"][number]]));
    const kdaByMatch = new Map<number, Map<string, AxisKda>>();
    for (const row of kdaRows) {
      const recorded = kdaByMatch.get(row.match_number) ?? new Map<string, AxisKda>();
      recorded.set(row.discord_id, { kills: row.kills, deaths: row.deaths, assists: row.assists });
      kdaByMatch.set(row.match_number, recorded);
    }
    return uniqueNumbers.map((matchNumber) => buildAxisMatchReview(
      matchNumber,
      submissionsByMatch.get(matchNumber) ?? [],
      primaryByMatch.get(matchNumber) ?? null,
      archiveByMatch.get(matchNumber) ?? null,
      kdaByMatch.get(matchNumber) ?? new Map(),
    )).filter((review): review is AxisMatchReviewView => review !== null);
  }
  return {
    preparePlayerProfiles() {
      if (db.prepare("SELECT ready FROM axis_participant_migration WHERE id=1").get().ready
        && db.prepare("SELECT payload FROM axis_archive_seasons WHERE id=1").get().payload != null) return;
      db.exec("BEGIN IMMEDIATE");
      try {
        backfillParticipants();
        if (db.prepare("SELECT payload FROM axis_archive_seasons WHERE id=1").get().payload == null) updateSeasons();
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    readPlayerIdentity(aid: number): AxisIdentity | null {
      const mappings = db.prepare("SELECT discord_id,mode FROM axis_league_profiles WHERE aid=? ORDER BY mode='arena' DESC,discord_id").all(aid);
      const link = mappings.find((entry: { mode: string }) => entry.mode === "arena") ?? (mappings.length === 1 ? mappings[0] : null);
      if (!link) return null;
      let player: Pick<AxisPlayer, "name" | "avatarUrl"> | undefined = readSnapshotPlayers().find(entry => entry.id === link.discord_id);
      if (!player) {
        const row = db.prepare("SELECT m.payload FROM axis_match_participants p JOIN axis_archive_matches m ON m.number=p.match_number WHERE p.discord_id=? AND json_extract(m.payload,'$.queueId')=? ORDER BY p.match_number DESC LIMIT 1").get(link.discord_id, AXIS_CHANNEL_ID);
        if (row) player = (JSON.parse(row.payload) as AxisHistoryPage["matches"][number]).teams.flatMap(team => team.players).find(entry => entry.id === link.discord_id);
      }
      return { id: link.discord_id, name: player?.name ?? link.discord_id, avatarUrl: player?.avatarUrl ?? null, profile: { aid, mode: "arena" } };
    },
    readPlayerProfile(aid: number, season = "current", page = 1, result = "all", now = Date.now()): AxisPlayerProfileResponse | null {
      const identity = this.readPlayerIdentity(aid);
      if (!identity) return null;
      const savedSeasons = db.prepare("SELECT payload FROM axis_archive_seasons WHERE id=1").get().payload;
      if (savedSeasons == null || !db.prepare("SELECT ready FROM axis_participant_migration WHERE id=1").get().ready) throw new Error("Axis profile preparation pending");
      const archive = this.archiveState(), seasons = JSON.parse(savedSeasons) as AxisSeason[];
      const selected = seasons.find(entry => entry.id === season);
      if (season !== "all" && !selected) throw new RangeError("Unknown AXIS season");
      const conditions = "json_extract(m.payload,'$.queueId')=?" + (selected ? " AND json_extract(m.payload,'$.time')>=?" + (selected.endsAt == null ? "" : " AND json_extract(m.payload,'$.time')<?") : "");
      const bounds = [AXIS_CHANNEL_ID, ...(selected ? [selected.startsAt, ...(selected.endsAt == null ? [] : [selected.endsAt])] : [])];
      const revision = playerVersion.get().revision as number;
      const version = `${revision}:${selected?.startsAt ?? "all"}:${selected?.endsAt ?? ""}:${Boolean(archive.complete)}`;
      const key = `${identity.id}:${season}`;
      let cached = playerSummaries.get(key);
      if (cached?.version !== version) {
        const players = readSnapshotPlayers();
        let baseline = periodAverages.get(season);
        if (baseline?.version !== revision) {
          const valid = " AND (json_extract(m.payload,'$.winner')>=0 OR json_extract(m.payload,'$.winner')=-2)";
          const average = selected?.current ? axisLeagueAverages(players) : db.prepare(`SELECT AVG(games) AS games,AVG(wins) AS wins,AVG(losses) AS losses,AVG(winrate) AS winrate FROM (
            SELECT p.discord_id,COUNT(*) AS games,SUM(json_extract(m.payload,'$.winner')=p.team_index) AS wins,
              SUM(json_extract(m.payload,'$.winner')>=0 AND json_extract(m.payload,'$.winner')<>p.team_index) AS losses,
              SUM(json_extract(m.payload,'$.winner')=p.team_index)*1.0/NULLIF(SUM(json_extract(m.payload,'$.winner')>=0),0) AS winrate
            FROM axis_match_participants p JOIN axis_archive_matches m ON m.number=p.match_number
            WHERE ${conditions}${valid} GROUP BY p.discord_id)`).get(...bounds);
          const kda = db.prepare(`WITH ranked AS (
            SELECT p.match_number,p.discord_id,ROW_NUMBER() OVER (PARTITION BY p.discord_id ORDER BY p.match_number DESC) AS recent_rank
            FROM axis_match_participants p JOIN axis_archive_matches m ON m.number=p.match_number WHERE ${conditions}${valid}
          ) SELECT AVG((k.kills+k.assists)*1.0/MAX(k.deaths,1)) AS value,
            AVG(CASE WHEN r.recent_rank<=10 THEN (k.kills+k.assists)*1.0/MAX(k.deaths,1) END) AS recent
            FROM ranked r JOIN axis_match_kda k ON k.match_number=r.match_number AND k.discord_id=r.discord_id`).get(...bounds);
          baseline = { version: revision, averages: average, kda: kda.value, recentKda: kda.recent };
          if (periodAverages.size >= 16) periodAverages.delete(periodAverages.keys().next().value!);
          periodAverages.set(season, baseline);
        }
        const links = profileLinks();
        const recorded = new Map<number, AxisKda>(db.prepare("SELECT match_number,kills,deaths,assists FROM axis_match_kda WHERE discord_id=?").all(identity.id)
          .map((row: AxisKda & { match_number: number }) => [row.match_number, { kills: row.kills, deaths: row.deaths, assists: row.assists }]));
        const matches = db.prepare(`SELECT m.payload FROM axis_match_participants p JOIN axis_archive_matches m ON m.number=p.match_number
          WHERE p.discord_id=? AND ${conditions} ORDER BY m.number DESC`).all(identity.id, ...bounds)
          .map((row: { payload: string }) => {
            const match = JSON.parse(row.payload) as AxisHistoryPage["matches"][number];
            for (const team of match.teams) for (const player of team.players) {
              player.profile = links.get(player.id) ?? null;
              if (player.id === identity.id) player.kda = recorded.get(match.number) ?? null;
            }
            return match;
          });
        cached = { version, summary: { ...buildAxisPlayerSummary(identity, matches, players, Boolean(selected?.current), baseline.averages, baseline.kda, Boolean(archive.complete)), averageRecentKda: baseline.recentKda } };
        if (playerSummaries.size >= 32) playerSummaries.delete(playerSummaries.keys().next().value!);
        playerSummaries.set(key, cached);
      }
      const resultSql = result === "win" ? " AND json_extract(m.payload,'$.winner')=p.team_index" : result === "loss" ? " AND json_extract(m.payload,'$.winner')>=0 AND json_extract(m.payload,'$.winner')<>p.team_index" : "";
      const where = ` FROM axis_match_participants p JOIN axis_archive_matches m ON m.number=p.match_number WHERE p.discord_id=? AND ${conditions}${resultSql}`;
      const total = db.prepare("SELECT COUNT(*) AS n" + where).get(identity.id, ...bounds).n as number;
      const matches = db.prepare("SELECT m.payload" + where + " ORDER BY m.number DESC LIMIT ? OFFSET ?")
        .all(identity.id, ...bounds, AXIS_PLAYER_PAGE_SIZE, (page - 1) * AXIS_PLAYER_PAGE_SIZE).map((row: { payload: string }) => JSON.parse(row.payload));
      const state = db.prepare("SELECT updated_at,last_error FROM axis_league_snapshot WHERE id=1").get();
      const updatedAt = archive.updated_at ?? state.updated_at;
      const stale = Boolean(archive.last_error || state.last_error) || updatedAt != null && now - updatedAt > AXIS_REFRESH_MS * 2;
      return { ...cached.summary, aid, season, updatedAt, stale, history: { page, pages: Math.max(1, Math.ceil(total / AXIS_PLAYER_PAGE_SIZE)), total,
        matches: decorateMatches(matches), season, seasons: archive.complete ? seasons : seasons.filter(entry => entry.current),
        archiveComplete: Boolean(archive.complete), updatedAt: archive.updated_at, available: archive.updated_at != null, stale } };
    },
    rememberGoogleAccount(subject: string, name: string | null) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(subject) || name !== null && (typeof name !== "string" || !name.trim() || name.length > 200)) throw new TypeError("Invalid Google identity");
      const normalized = name?.trim() ?? null;
      // Even a no-op UPSERT takes SQLite's writer lock. Session reads need only a lookup.
      const existing = db.prepare("SELECT name FROM axis_google_accounts WHERE google_sub=?").get(subject);
      if (existing && existing.name === normalized) return;
      db.prepare(`INSERT INTO axis_google_accounts(google_sub,name) VALUES(?,?)
        ON CONFLICT(google_sub) DO UPDATE SET name=excluded.name WHERE name IS NOT excluded.name`).run(subject, normalized);
    },
    listKdaEditors(): { subject: string; name: string | null }[] {
      return db.prepare(`SELECT e.google_sub AS subject,a.name FROM axis_kda_editors e
        LEFT JOIN axis_google_accounts a ON a.google_sub=e.google_sub ORDER BY e.google_sub`).all();
    },
    isKdaEditor(subject: string): boolean { return Boolean(db.prepare("SELECT 1 FROM axis_kda_editors WHERE google_sub=?").get(subject)); },
    setKdaEditor(subject: string, enabled: boolean) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(subject) || typeof enabled !== "boolean") throw new TypeError("Invalid editor identity");
      withImmediateTransaction(() => {
        if (enabled) {
          db.prepare("INSERT INTO axis_match_roles(google_sub,role) VALUES(?, 'moderator') ON CONFLICT(google_sub) DO UPDATE SET role=excluded.role").run(subject);
          db.prepare("INSERT OR IGNORE INTO axis_kda_editors(google_sub) VALUES(?)").run(subject);
        } else {
          db.prepare("DELETE FROM axis_match_roles WHERE google_sub=?").run(subject);
          db.prepare("DELETE FROM axis_kda_editors WHERE google_sub=?").run(subject);
        }
      });
    },
    listAxisRoles(): { subject: string; name: string | null; role: AxisUploadRole }[] {
      return db.prepare(`SELECT subject,name,role FROM (
        SELECT e.google_sub AS subject,a.name,'moderator' AS role FROM axis_kda_editors e
          LEFT JOIN axis_google_accounts a ON a.google_sub=e.google_sub
        UNION
        SELECT r.google_sub AS subject,a.name,r.role FROM axis_match_roles r
          LEFT JOIN axis_google_accounts a ON a.google_sub=r.google_sub
      ) ORDER BY subject`).all();
    },
    isAxisUploader(subject: string): boolean {
      return Boolean(db.prepare("SELECT 1 FROM axis_match_roles WHERE google_sub=?").get(subject)
        || db.prepare("SELECT 1 FROM axis_kda_editors WHERE google_sub=?").get(subject));
    },
    isAxisModerator(subject: string): boolean {
      return Boolean(db.prepare("SELECT 1 FROM axis_match_roles WHERE google_sub=? AND role='moderator'").get(subject)
        || db.prepare("SELECT 1 FROM axis_kda_editors WHERE google_sub=?").get(subject));
    },
    readAxisRole(subject: string): AxisUploadRole | null {
      const row = db.prepare(`SELECT role FROM (
        SELECT 'moderator' AS role FROM axis_kda_editors WHERE google_sub=?
        UNION ALL
        SELECT role FROM axis_match_roles WHERE google_sub=?
      ) LIMIT 1`).get(subject, subject);
      return row?.role === "player" || row?.role === "moderator" ? row.role : null;
    },
    setAxisRole(subject: string, role: AxisUploadRole | null) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(subject) || role !== null && role !== "player" && role !== "moderator") throw new TypeError("Invalid AXIS role");
      withImmediateTransaction(() => {
        if (role === null) {
          db.prepare("DELETE FROM axis_match_roles WHERE google_sub=?").run(subject);
          db.prepare("DELETE FROM axis_kda_editors WHERE google_sub=?").run(subject);
        } else {
          db.prepare("INSERT INTO axis_match_roles(google_sub,role) VALUES(?,?) ON CONFLICT(google_sub) DO UPDATE SET role=excluded.role").run(subject, role);
          if (role === "moderator") db.prepare("INSERT OR IGNORE INTO axis_kda_editors(google_sub) VALUES(?)").run(subject);
          else db.prepare("DELETE FROM axis_kda_editors WHERE google_sub=?").run(subject);
        }
      });
    },
    readMatchKda(matchNumber: number): Map<string, AxisKda> {
      return new Map(db.prepare("SELECT discord_id,kills,deaths,assists FROM axis_match_kda WHERE match_number=?").all(matchNumber)
        .map((row: { discord_id: string; kills: number; deaths: number; assists: number }) => [row.discord_id, { kills: row.kills, deaths: row.deaths, assists: row.assists }]));
    },
    readAxisMatchReview(matchNumber: number): AxisMatchReviewView | null {
      return readAxisMatchReviewsInternal([matchNumber])[0] ?? null;
    },
    readAxisMatchReviews(numbers: readonly number[]): AxisMatchReviewView[] {
      return readAxisMatchReviewsInternal(numbers);
    },
    readMatchPhotoMetadata(matchNumber: number): AxisMatchPhoto | null {
      const row = db.prepare("SELECT revision,width,height FROM axis_match_photos WHERE match_number=?").get(matchNumber);
      return row ? { revision: row.revision, width: row.width, height: row.height } : null;
    },
    readMatchPhoto(matchNumber: number): AxisStoredPhoto | null {
      return db.prepare("SELECT revision,width,height,data FROM axis_match_photos WHERE match_number=?").get(matchNumber) ?? null;
    },
    setMatchPhoto(matchNumber: number, expected: string | null, photo: AxisStoredPhoto | null): AxisMatchPhoto | null {
      return this.setMatchStats(matchNumber, [], undefined, { expected, photo }).photo!;
    },
    setMatchStats(matchNumber: number, input: AxisKdaChange[], roundInput?: AxisRoundChange, photoInput?: AxisPhotoChange, actor?: { sub: string; name: string | null }, review?: AxisMatchReview, rosterFingerprint?: string) {
      if (!Number.isSafeInteger(matchNumber) || matchNumber <= 0) throw new TypeError("Invalid match number");
      const changes = Array.isArray(input) && input.length === 0 ? [] : parseAxisKdaChanges(input);
      const rounds = roundInput === undefined ? undefined : parseAxisRoundChange(roundInput);
      if (photoInput !== undefined) {
        const { expected, photo } = photoInput;
        if (expected !== null && (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected))) throw new TypeError("Invalid expected photo");
        if (photo && (!/^[a-f0-9]{64}$/.test(photo.revision) || !Number.isSafeInteger(photo.width) || !Number.isSafeInteger(photo.height)
          || photo.width <= 0 || photo.height <= 0 || photo.width * photo.height > AXIS_PHOTO_MAX_PIXELS
          || !(photo.data instanceof Uint8Array) || !photo.data.length || photo.data.length > AXIS_PHOTO_MAX_BYTES)) throw new TypeError("Invalid photo data");
      }
      if (!changes.length && rounds === undefined && photoInput === undefined) throw new TypeError("No match changes");
      if (actor && (!/^[A-Za-z0-9_-]{1,128}$/.test(actor.sub) || actor.name !== null && (typeof actor.name !== "string" || !actor.name.trim() || actor.name.length > 200))) throw new TypeError("Invalid match editor");
      if (rosterFingerprint !== undefined && (typeof rosterFingerprint !== "string" || !rosterFingerprint.length || rosterFingerprint.length > 20_000)) throw new TypeError("Invalid match roster");
      if (review !== undefined && (review.matchNumber !== matchNumber || !/^[a-f0-9]{64}$/.test(review.photoRevision)
        || !Array.isArray(review.recognizedNames) || !Array.isArray(review.unmatchedNames) || !Array.isArray(review.missingDiscordIds)
        || !/^[A-Za-z0-9_-]{1,128}$/.test(review.uploadedBy) || !Number.isSafeInteger(review.uploadedAt))) throw new TypeError("Invalid match review");
      const changed = changes.some(change => !sameAxisKda(change.kda, change.expected))
        || rounds !== undefined && !sameAxisRoundScore(rounds.score, rounds.expected)
        || photoInput !== undefined && (photoInput.photo?.revision ?? null) !== photoInput.expected;
      let edited: AxisMatchEdit | undefined;
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
        if (rosterFingerprint !== undefined) {
          const currentArchived = db.prepare("SELECT payload FROM axis_archive_matches WHERE number=?").get(matchNumber);
          const currentMatch = currentArchived ? JSON.parse(currentArchived.payload) as AxisHistoryPage["matches"][number] : undefined;
          if (!currentMatch || axisMatchRosterFingerprintForMatch(currentMatch) !== rosterFingerprint) {
            throw new AxisKdaConflict("Match roster changed while the screenshot was being processed");
          }
        }
        let statsChanged = false;
        let previousPhoto: { revision: string; width: number; height: number; data: Uint8Array } | null = null;
        if (photoInput !== undefined) {
          const current = db.prepare("SELECT revision FROM axis_match_photos WHERE match_number=?").get(matchNumber);
          if ((current?.revision ?? null) !== photoInput.expected) throw new AxisKdaConflict("Photo was changed by another editor");
          if (photoInput.photo) previousPhoto = db.prepare("SELECT revision,width,height,data FROM axis_match_photos WHERE match_number=?").get(matchNumber) ?? null;
        }
        if (rounds !== undefined) {
          const existing = db.prepare("SELECT team_a AS a,team_b AS b FROM axis_match_rounds WHERE match_number=?").get(matchNumber) ?? null;
          if (!sameAxisRoundScore(existing, rounds.expected)) throw new AxisKdaConflict("Round score was changed by another editor");
        }
        for (const change of changes) {
          const existing = read.get(matchNumber, change.discordId) ?? null;
          if (!sameAxisKda(existing, change.expected)) throw new AxisKdaConflict("Match statistics were changed by another administrator");
        }
        for (const { discordId, kda, expected } of changes) {
          if (sameAxisKda(kda, expected)) continue;
          statsChanged = true;
          if (kda) save.run(matchNumber, discordId, kda.kills, kda.deaths, kda.assists);
          else remove.run(matchNumber, discordId);
        }
        if (rounds !== undefined && !sameAxisRoundScore(rounds.score, rounds.expected)) {
          statsChanged = true;
          if (rounds.score) db.prepare("INSERT INTO axis_match_rounds(match_number,team_a,team_b) VALUES(?,?,?) ON CONFLICT(match_number) DO UPDATE SET team_a=excluded.team_a,team_b=excluded.team_b").run(matchNumber, rounds.score.a, rounds.score.b);
          else db.prepare("DELETE FROM axis_match_rounds WHERE match_number=?").run(matchNumber);
        }
        if (photoInput !== undefined) {
          const photo = photoInput.photo;
          if (photo && previousPhoto && previousPhoto.revision !== photo.revision) {
            db.prepare(`INSERT OR IGNORE INTO axis_match_submissions(match_number,photo_revision,width,height,data,recognized_names,unmatched_names,missing_discord_ids,conflicts,round_conflict,google_sub,uploaded_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(matchNumber, previousPhoto.revision, previousPhoto.width, previousPhoto.height, previousPhoto.data,
              JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), null, "legacy", 0);
          }
          if (photo) db.prepare("INSERT INTO axis_match_photos(match_number,revision,width,height,data) VALUES(?,?,?,?,?) ON CONFLICT(match_number) DO UPDATE SET revision=excluded.revision,width=excluded.width,height=excluded.height,data=excluded.data")
            .run(matchNumber, photo.revision, photo.width, photo.height, photo.data);
          else db.prepare("DELETE FROM axis_match_photos WHERE match_number=?").run(matchNumber);
        }
        if (review !== undefined && photoInput?.photo) db.prepare(`INSERT OR IGNORE INTO axis_match_submissions(match_number,photo_revision,width,height,data,recognized_names,unmatched_names,missing_discord_ids,conflicts,round_conflict,google_sub,uploaded_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(review.matchNumber, review.photoRevision, photoInput.photo.width, photoInput.photo.height, photoInput.photo.data,
          JSON.stringify(review.recognizedNames), JSON.stringify(review.unmatchedNames), JSON.stringify(review.missingDiscordIds), JSON.stringify([]), null, review.uploadedBy, review.uploadedAt);
        if (actor && changed) {
          edited = { name: actor.name?.trim() ?? null, at: Date.now() };
          this.rememberGoogleAccount(actor.sub, edited.name);
          db.prepare(`INSERT INTO axis_match_edits(match_number,google_sub,name,edited_at) VALUES(?,?,?,?)
            ON CONFLICT(match_number) DO UPDATE SET google_sub=excluded.google_sub,name=excluded.name,edited_at=excluded.edited_at`)
            .run(matchNumber, actor.sub, edited.name, edited.at);
        }
        if (statsChanged) rebuildPredictions();
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return { edited, players: changes.map(({ discordId, kda }) => ({ discordId, kda })), rounds: rounds?.score, photo: photoInput === undefined ? undefined : photoInput.photo ? { revision: photoInput.photo.revision, width: photoInput.photo.width, height: photoInput.photo.height } : null };
    },
    /** Merge OCR output from a screenshot without replacing an already recorded value. */
    submitAxisMatch(matchNumber: number, photo: AxisStoredPhoto, input: AxisKdaChange[], roundInput: AxisRoundChange | undefined,
      evidence: Pick<AxisMatchReview, "recognizedNames" | "unmatchedNames"> & Partial<Pick<AxisMatchReview, "missingDiscordIds">>,
      actor: { sub: string; name: string | null; source?: "google" | "discord" }, rosterFingerprint?: string) {
      if (!Number.isSafeInteger(matchNumber) || matchNumber <= 0) throw new TypeError("Invalid match number");
      if (!photo || !/^[a-f0-9]{64}$/.test(photo.revision) || !Number.isSafeInteger(photo.width) || !Number.isSafeInteger(photo.height)
        || photo.width <= 0 || photo.height <= 0 || photo.width * photo.height > AXIS_PHOTO_MAX_PIXELS
        || !(photo.data instanceof Uint8Array) || !photo.data.length || photo.data.length > AXIS_PHOTO_MAX_BYTES) throw new TypeError("Invalid photo data");
      const changes = input.length === 0 ? [] : parseAxisKdaChanges(input);
      const rounds = roundInput === undefined ? undefined : parseAxisRoundChange(roundInput);
      const missingDiscordIds = evidence.missingDiscordIds ?? [];
      if (!Array.isArray(evidence.recognizedNames) || !Array.isArray(evidence.unmatchedNames)
        || evidence.recognizedNames.some((name) => typeof name !== "string" || name.length > 200)
        || evidence.unmatchedNames.some((name) => typeof name !== "string" || name.length > 200)
        || !Array.isArray(missingDiscordIds)
        || missingDiscordIds.some((discordId) => typeof discordId !== "string" || discordId.length > 200)) throw new TypeError("Invalid OCR evidence");
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(actor.sub) || actor.name !== null && (typeof actor.name !== "string" || !actor.name.trim() || actor.name.length > 200)) throw new TypeError("Invalid uploader");
      if (rosterFingerprint !== undefined && (typeof rosterFingerprint !== "string" || !rosterFingerprint.length || rosterFingerprint.length > 20_000)) throw new TypeError("Invalid match roster");
      const archived = db.prepare("SELECT payload FROM axis_archive_matches WHERE number=?").get(matchNumber);
      let match = archived ? JSON.parse(archived.payload) as AxisHistoryPage["matches"][number] : undefined;
      if (!match) throw new RangeError("Unknown match");
      if (rounds?.score && match.teams.length !== 2) throw new RangeError("Round score requires two teams");
      let participants = new Map(match.teams.flatMap((team) => team.players.map((player) => [player.id, player.name] as const)));
      if (changes.some((change) => !participants.has(change.discordId))) throw new RangeError("Player is not in this match");
      const read = db.prepare("SELECT kills,deaths,assists FROM axis_match_kda WHERE match_number=? AND discord_id=?");
      const save = db.prepare("INSERT INTO axis_match_kda(match_number,discord_id,kills,deaths,assists) VALUES(?,?,?,?,?) ON CONFLICT(match_number,discord_id) DO UPDATE SET kills=excluded.kills,deaths=excluded.deaths,assists=excluded.assists");
      const existingRound = () => db.prepare("SELECT team_a AS a,team_b AS b FROM axis_match_rounds WHERE match_number=?").get(matchNumber) ?? null;
      const conflicts: AxisMatchConflict[] = [];
      let roundConflict: { existing: AxisRoundScore; incoming: AxisRoundScore } | null = null;
      let duplicate = false;
      let statsChanged = false;
      const uploadedAt = Date.now();
      db.exec("BEGIN IMMEDIATE");
      try {
        const currentArchived = db.prepare("SELECT payload FROM axis_archive_matches WHERE number=?").get(matchNumber);
        match = currentArchived ? JSON.parse(currentArchived.payload) as AxisHistoryPage["matches"][number] : undefined;
        if (!match) throw new RangeError("Unknown match");
        if (rosterFingerprint !== undefined && axisMatchRosterFingerprintForMatch(match) !== rosterFingerprint) {
          throw new AxisKdaConflict("Match roster changed while the screenshot was being processed");
        }
        if (rounds?.score && match.teams.length !== 2) throw new RangeError("Round score requires two teams");
        participants = new Map(match.teams.flatMap((team) => team.players.map((player) => [player.id, player.name] as const)));
        if (changes.some((change) => !participants.has(change.discordId))) throw new RangeError("Player is not in this match");
        if (missingDiscordIds.some((discordId) => !participants.has(discordId))) throw new TypeError("Invalid OCR evidence");
        const prior = db.prepare("SELECT conflicts,round_conflict FROM axis_match_submissions WHERE match_number=? AND photo_revision=?")
          .get(matchNumber, photo.revision);
        duplicate = Boolean(prior);
        if (!duplicate) for (const change of changes) {
          if (!change.kda) continue;
          const existing = read.get(matchNumber, change.discordId) as AxisKda | null;
          if (!existing) {
            save.run(matchNumber, change.discordId, change.kda.kills, change.kda.deaths, change.kda.assists);
            statsChanged = true;
          } else if (!sameAxisKda(existing, change.kda)) {
            conflicts.push({ discordId: change.discordId, name: participants.get(change.discordId) ?? change.discordId, existing, incoming: change.kda });
          }
        }
        if (!duplicate && rounds?.score) {
          const existing = existingRound();
          if (!existing) {
            db.prepare("INSERT INTO axis_match_rounds(match_number,team_a,team_b) VALUES(?,?,?)").run(matchNumber, rounds.score.a, rounds.score.b);
            statsChanged = true;
          } else if (!sameAxisRoundScore(existing, rounds.score)) roundConflict = { existing, incoming: rounds.score };
        }
        const previousPhoto = !duplicate && db.prepare("SELECT revision,width,height,data FROM axis_match_photos WHERE match_number=?").get(matchNumber);
        // Older photos predate axis_match_submissions. Keep their bytes as
        // reviewable evidence before replacing the primary photo.
        if (previousPhoto && previousPhoto.revision !== photo.revision) {
          db.prepare(`INSERT OR IGNORE INTO axis_match_submissions(match_number,photo_revision,width,height,data,recognized_names,unmatched_names,missing_discord_ids,conflicts,round_conflict,google_sub,uploaded_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(matchNumber, previousPhoto.revision, previousPhoto.width, previousPhoto.height, previousPhoto.data,
            JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), JSON.stringify([]), null, "legacy", 0);
        }
        if (!duplicate) db.prepare(`INSERT OR IGNORE INTO axis_match_submissions(match_number,photo_revision,width,height,data,recognized_names,unmatched_names,missing_discord_ids,conflicts,round_conflict,google_sub,uploaded_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(matchNumber, photo.revision, photo.width, photo.height, photo.data,
          JSON.stringify(evidence.recognizedNames), JSON.stringify(evidence.unmatchedNames), JSON.stringify([...new Set(missingDiscordIds)]), JSON.stringify(conflicts), roundConflict ? JSON.stringify(roundConflict) : null, actor.sub, uploadedAt);
        if (!duplicate) db.prepare("INSERT INTO axis_match_photos(match_number,revision,width,height,data) VALUES(?,?,?,?,?) ON CONFLICT(match_number) DO UPDATE SET revision=excluded.revision,width=excluded.width,height=excluded.height,data=excluded.data")
          .run(matchNumber, photo.revision, photo.width, photo.height, photo.data);
        // Discord authors are provenance for a submission, not Google
        // identities. Keep them in the submission row without polluting the
        // Google account directory used by moderator role screens.
        const isDiscordActor = actor.source === "discord" || actor.sub.startsWith("discord_");
        if (!duplicate && !isDiscordActor) this.rememberGoogleAccount(actor.sub, actor.name?.trim() ?? null);
        if (statsChanged) rebuildPredictions();
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      const recorded = this.readMatchKda(matchNumber);
      const missingPlayers = match.teams.flatMap((team) => team.players.filter((player) => !recorded.has(player.id)));
      const review = this.readAxisMatchReview(matchNumber);
      return { players: [...recorded].map(([discordId, kda]) => ({ discordId, kda })), rounds: db.prepare("SELECT team_a AS a,team_b AS b FROM axis_match_rounds WHERE match_number=?").get(matchNumber) ?? null,
        photo: this.readMatchPhotoMetadata(matchNumber), conflicts, roundConflict,
        review, missingPlayers: missingPlayers.map((player) => ({ discordId: player.id, name: player.name })) };
    },
    readAxisMatchSubmissionPhoto(matchNumber: number, revision: string): AxisStoredPhoto | null {
      if (!Number.isSafeInteger(matchNumber) || matchNumber <= 0 || !/^[a-f0-9]{64}$/.test(revision)) throw new TypeError("Invalid submission photo");
      return db.prepare("SELECT photo_revision AS revision,width,height,data FROM axis_match_submissions WHERE match_number=? AND photo_revision=?").get(matchNumber, revision) ?? null;
    },
    archiveState() { return db.prepare("SELECT * FROM axis_archive_state WHERE id = 1").get(); },
    archiveMatchNumbers(): number[] { return db.prepare("SELECT number FROM axis_archive_matches").all().map((row: { number: number }) => row.number); },
    claimArchiveRefresh(now = Date.now(), headOnly = false): boolean {
      // HTTP fallback must leave the 30-second import slots to the dedicated worker.
      const interval = headOnly || this.archiveState().complete ? AXIS_REFRESH_MS : 30_000;
      return db.prepare("UPDATE axis_archive_state SET attempted_at = ? WHERE id = 1 AND attempted_at <= ?").run(now, now - interval).changes === 1;
    },
    publishArchive(data: AxisHistoryPage, now = Date.now()) {
      this.publishArchiveBatch([data], now);
    },
    publishArchiveBatch(pages: readonly AxisHistoryPage[], now = Date.now()) {
      if (!pages.length) return;
      const statement = db.prepare("INSERT INTO axis_archive_matches(number,payload) VALUES(?,?) ON CONFLICT(number) DO UPDATE SET payload=excluded.payload WHERE payload<>excluded.payload");
      const read = db.prepare("SELECT payload FROM axis_archive_matches WHERE number=?");
      db.exec("BEGIN IMMEDIATE");
      try {
        const revision = previewVersion.get().revision as number;
        let progress = this.archiveState();
        backfillParticipants();
        let changed = false, predictionChanged = false;
        for (const data of pages) {
          for (const match of data.matches) {
            const previous = read.get(match.number);
            if (!statement.run(match.number, JSON.stringify(match)).changes) continue;
            changed = true;
            if (!previous || predictionInput(JSON.parse(previous.payload)) !== predictionInput(match)) predictionChanged = true;
          }
          // Pages can shift during import. Count distinct saved records after each
          // page so the cursor has the same behavior as sequential publication.
          const count = db.prepare("SELECT COUNT(*) AS n FROM axis_archive_matches").get().n;
          progress = advanceAxisArchiveState(progress, data, count);
        }
        if (changed || db.prepare("SELECT payload FROM axis_archive_seasons WHERE id=1").get().payload == null) updateSeasons();
        db.prepare("UPDATE axis_archive_state SET updated_at=?,last_error=0,complete=?,next_page=? WHERE id=1")
          .run(now, progress.complete, progress.next_page);
        rebuildPredictions(predictionChanged ? undefined : revision);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    failArchiveRefresh() { db.prepare("UPDATE axis_archive_state SET last_error=1 WHERE id=1").run(); },
    readMatchHistory(number: number, now = Date.now()): AxisHistoryResponse {
      const state = this.archiveState();
      const saved = db.prepare("SELECT payload FROM axis_archive_matches WHERE number=?").get(number);
      return { page: 1, pages: 1, total: saved ? 1 : 0, season: "all", matchNumber: number,
        matches: saved ? decorateMatches([JSON.parse(saved.payload)]) : [],
        archiveComplete: Boolean(state.complete), updatedAt: state.updated_at, available: state.updated_at != null,
        stale: Boolean(state.last_error) || state.updated_at != null && now - state.updated_at > AXIS_REFRESH_MS * 2 };
    },
    readSeasonHistory(page: number, season: string, now = Date.now(), map?: string): AxisHistoryResponse {
      const state = this.archiveState();
      const seasons = readSeasons();
      const selected = seasons.find((entry) => entry.id === season);
      if (season !== "all" && !selected) throw new RangeError("Unknown AXIS season");
      const where = selected ? " WHERE json_extract(payload, '$.queueId')=? AND json_extract(payload, '$.time')>=?" + (selected.endsAt == null ? "" : " AND json_extract(payload, '$.time')<?") : "";
      const parameters = selected ? [AXIS_CHANNEL_ID, selected.startsAt, ...(selected.endsAt == null ? [] : [selected.endsAt])] : [];
      const listWhere = map == null ? where : where + (where ? " AND " : " WHERE ")
        + "EXISTS (SELECT 1 FROM json_each(axis_archive_matches.payload,'$.maps') WHERE value=?)";
      const listParameters = map == null ? parameters : [...parameters, map];
      const total = db.prepare("SELECT COUNT(*) AS n FROM axis_archive_matches" + listWhere).get(...listParameters).n;
      // The summary is independent of map/page. Reuse it until persisted match data changes,
      // including imports from another SQLite handle or worker.
      const saved = historyVersion.get();
      const revision = `${saved.matches_revision}:${saved.version}:${saved.prediction_revision}`;
      if (revision !== historySummaryRevision) {
        historySummaries.clear(); historySummaryRevision = revision;
      }
      const summaryKey = selected ? `${selected.startsAt}:${selected.endsAt ?? ""}` : "all";
      let summary = historySummaries.get(summaryKey);
      if (!summary) {
        const completed = "SELECT number,payload FROM axis_archive_matches" + where + (where ? " AND " : " WHERE ")
          + "(json_extract(payload,'$.winner')>=0 OR json_extract(payload,'$.winner')=-2)";
        const counts = db.prepare(
          "SELECT COUNT(*) AS played,COALESCE(SUM(json_extract(payload,'$.winner')=0),0) AS winsA,"
          + "COALESCE(SUM(json_extract(payload,'$.winner')=1),0) AS winsB,"
          + "COUNT(CASE WHEN json_extract(payload,'$.winner') IN (0,1) THEN p.number END) AS predictedMatches,"
          + "AVG(CASE WHEN json_extract(payload,'$.winner') IN (0,1) THEN p.a END) AS probabilityA"
          + " FROM (" + completed + ") m LEFT JOIN axis_match_predictions p ON p.number=m.number AND ?"
        ).get(...parameters, Number(saved.version === AXIS_PREDICTION_VERSION && saved.prediction_revision === saved.matches_revision));
        const maps = db.prepare(
          "SELECT name,COUNT(*) AS matches FROM (SELECT DISTINCT m.number,map.value AS name FROM ("
          + completed + ") m,json_each(m.payload,'$.maps') map WHERE map.type='text')"
          + " GROUP BY name ORDER BY matches DESC,name COLLATE NOCASE,name"
        ).all(...parameters).map((row: { name: string; matches: number }) => ({ name: row.name, matches: row.matches }));
        summary = { played: counts.played, winsA: counts.winsA, winsB: counts.winsB, maps,
          averageWinProbability: counts.predictedMatches ? { matches: counts.predictedMatches, a: counts.probabilityA, b: 1 - counts.probabilityA } : null };
        if (historySummaries.size >= 16) historySummaries.delete(historySummaries.keys().next().value!);
        historySummaries.set(summaryKey, summary);
      }
      const matches = db.prepare("SELECT payload FROM axis_archive_matches" + listWhere + " ORDER BY number DESC LIMIT ? OFFSET ?")
        .all(...listParameters, AXIS_HISTORY_PAGE_SIZE, (page - 1) * AXIS_HISTORY_PAGE_SIZE).map((row: { payload: string }) => JSON.parse(row.payload));
      return { page, total, pages: Math.max(1, Math.ceil(total / AXIS_HISTORY_PAGE_SIZE)), seasons: state.complete ? seasons : seasons.filter((entry) => entry.current), season, map,
        matches: decorateMatches(matches), summary,
        archiveComplete: Boolean(state.complete), updatedAt: state.updated_at, available: state.updated_at != null,
        stale: Boolean(state.last_error) || state.updated_at != null && now - state.updated_at > AXIS_REFRESH_MS * 2 };
    },
    read(now = Date.now()): AxisLeagueResponse {
      const row = db.prepare("SELECT * FROM axis_league_snapshot WHERE id = 1").get();
      const players: AxisPlayer[] = row.payload == null ? [] : JSON.parse(row.payload);
      const links = profileLinks();
      const currentSeason = readSeasons()[0];
      const previews = readPreviews(currentSeason.startsAt, this.archiveState());
      return { averageKda: previews.averageKda, currentSeason: { startsAt: currentSeason.startsAt, inferred: currentSeason.inferred, games: previews.games }, players: players.map((player) => ({ ...player, combatStats: previews.players.get(player.id)?.combatStats ?? null, recentMatches: previews.players.get(player.id)?.recentMatches ?? [], profile: links.get(player.id) ?? null })),
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
