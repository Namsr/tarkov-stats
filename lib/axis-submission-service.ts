import { getAxisLeagueStore } from "@/lib/admin/axis-league-db";
import { AxisKdaConflict } from "@/lib/axis-kda";
import { axisOcrConfidencePercent, parseAxisOcrCounter } from "@/lib/axis-ocr";
import { axisOcrContextForMatch, axisOcrRosterFingerprint, axisOcrStatsPlayerIds, validateAxisOcrNames, AxisOcrMatchMismatchError } from "@/lib/axis-server-match-validation";
import { AxisOcrBusyError, recognizeAxisPhotoUpload } from "@/lib/server-axis-ocr";
import { AxisPhotoInputError } from "@/lib/axis-match-photo";
import { parseAxisOcrNameRows, recheckAxisMatchReviewNames } from "@/lib/axis-match-submission";

export interface AxisSubmissionActor {
  sub: string;
  name: string | null;
  source?: "google" | "discord";
}

export type AxisSubmissionAuthorization =
  | { ok: true; actor: AxisSubmissionActor }
  | { ok: false; status: number };

export interface AxisSubmissionRequest {
  matchNumber: number;
  photoData: string;
  actor: AxisSubmissionActor;
  /**
   * Browser uploads pass a second authorization check here.  Discord requests
   * are authenticated by their bearer secret and do not need a session check.
   */
  reauthorize?: () => Promise<AxisSubmissionAuthorization>;
}

export class AxisSubmissionAuthorizationError extends Error {
  readonly status: number;

  constructor(status: number) {
    super("AXIS submission authorization expired");
    this.status = status;
  }
}

export class AxisSubmissionMatchNotFoundError extends Error {
  constructor() { super("AXIS match was not found"); }
}

export interface AxisSubmissionResult {
  matchNumber: number;
  players: { discordId: string; kda: { kills: number; deaths: number; assists: number } }[];
  rounds: { a: number; b: number } | null;
  photo: { revision: string; width: number; height: number } | null;
  recognizedPlayers: number;
  totalPlayers: number;
  coveragePercent: number;
  confidencePercent: number | null;
  needsReview: boolean;
  missingPlayers: string[];
  unmatchedNames: string[];
  conflictPlayers: string[];
}

function confidenceReadings(result: Awaited<ReturnType<typeof recognizeAxisPhotoUpload>>["result"]) {
  return [
    { value: result.score.left, confidence: result.scoreConfidence?.left ?? null },
    { value: result.score.right, confidence: result.scoreConfidence?.right ?? null },
    ...result.rows.flatMap((row) => [
      { value: row.kills, confidence: row.numberConfidence?.kills ?? null },
      { value: row.deaths, confidence: row.numberConfidence?.deaths ?? null },
      { value: row.assists, confidence: row.numberConfidence?.assists ?? null },
    ]),
  ];
}

function isAxisSubmissionError(error: unknown, pattern: RegExp): boolean {
  return error instanceof Error && pattern.test(error.message);
}

/**
 * The single trusted AXIS screenshot pipeline used by browser and Discord
 * uploads.  It never accepts client-supplied statistics: all values come from
 * the server-side OCR result and the archived roster.
 */
export async function submitAxisScreenshot(request: AxisSubmissionRequest): Promise<AxisSubmissionResult> {
  if (!Number.isSafeInteger(request.matchNumber) || request.matchNumber <= 0
    || typeof request.photoData !== "string" || !request.photoData.length
    || !request.actor || typeof request.actor.sub !== "string" || !request.actor.sub.length
    || request.actor.name !== null && typeof request.actor.name !== "string"
    || request.actor.source !== undefined && request.actor.source !== "google" && request.actor.source !== "discord") {
    throw new TypeError("Invalid AXIS submission");
  }

  const store = await getAxisLeagueStore();
  const match = store.readMatchHistory(request.matchNumber).matches[0];
  if (!match || match.number !== request.matchNumber) throw new AxisSubmissionMatchNotFoundError();
  const context = await axisOcrContextForMatch(match);
  const { photo, result } = await recognizeAxisPhotoUpload(request.photoData);
  const validation = validateAxisOcrNames(result, context);
  const { recognizedNames, unmatchedNames } = validation;
  const safety = validation.safety;
  const assigned = new Set<string>();
  const changes: { discordId: string; kda: { kills: number; deaths: number; assists: number }; expected: null }[] = [];

  for (const row of result.rows) {
    const discordId = safety.safeAssignments[row.id];
    if (!discordId || safety.duplicateIds.has(discordId) || safety.blockedKdaSides.has(row.side) || assigned.has(discordId)) continue;
    const kills = parseAxisOcrCounter(row.kills);
    const deaths = parseAxisOcrCounter(row.deaths);
    const assists = parseAxisOcrCounter(row.assists);
    if (kills === null || deaths === null || assists === null) continue;
    assigned.add(discordId);
    changes.push({ discordId, kda: { kills, deaths, assists }, expected: null });
  }

  let rounds;
  const left = parseAxisOcrCounter(result.score.left);
  const right = parseAxisOcrCounter(result.score.right);
  if (left !== null && right !== null) {
    rounds = { score: validation.leftTeam === 0 ? { a: left, b: right } : { a: right, b: left }, expected: null };
  }

  const statIds = axisOcrStatsPlayerIds(result, validation);
  const missingDiscordIds = context.participants
    .filter(({ discordId }) => !statIds.has(discordId))
    .map(({ discordId }) => discordId);

  let actor = request.actor;
  if (request.reauthorize) {
    const refreshed = await request.reauthorize();
    if (!refreshed.ok) throw new AxisSubmissionAuthorizationError(refreshed.status);
    actor = refreshed.actor;
  }

  const saved = store.submitAxisMatch(
    request.matchNumber,
    photo,
    changes,
    rounds,
    { recognizedNames, unmatchedNames, missingDiscordIds, nameRows: parseAxisOcrNameRows(result.rows) },
    actor,
    axisOcrRosterFingerprint(match),
  );
  const review = saved.review ? recheckAxisMatchReviewNames(saved.review, context.participants) : null;
  const totalPlayers = context.participants.length;
  const recognizedPlayers = saved.players.length;
  const coveragePercent = totalPlayers === 0 ? 0 : Math.round(recognizedPlayers / totalPlayers * 100);
  const needsReview = Boolean(review && (
    review.missingStats.length > 0
    || review.nicknameMismatches.length > 0
    || review.unreadableNames > 0
    || review.conflicts.length > 0
    || review.roundConflict !== null
    || saved.rounds === null
  ));
  const publicUnmatchedNames = [...new Set(unmatchedNames.map((name) => name.trim()).filter(Boolean))];
  const missingPlayers = saved.missingPlayers.map(({ name }) => name);
  // A retry of the same normalized photo is intentionally a no-op in the
  // store, so its freshly computed conflict list is empty. Read the persisted
  // evidence for this photo to keep the public retry response stable.
  const photoConflicts = saved.review?.submissions.find((submission) => submission.photoRevision === photo.revision)?.conflicts
    ?? saved.conflicts;
  const conflictPlayers = [...new Set(photoConflicts.map(({ name }) => name))];

  return {
    matchNumber: request.matchNumber,
    players: saved.players,
    rounds: saved.rounds,
    photo: saved.photo,
    recognizedPlayers,
    totalPlayers,
    coveragePercent,
    confidencePercent: axisOcrConfidencePercent(confidenceReadings(result)),
    needsReview,
    missingPlayers,
    unmatchedNames: publicUnmatchedNames,
    conflictPlayers,
  };
}

/** Convert the shared pipeline failures into the public route status. */
export function axisSubmissionStatus(error: unknown): number {
  if (error instanceof AxisSubmissionAuthorizationError) return error.status;
  if (error instanceof AxisPhotoInputError) return error.status;
  if (error instanceof AxisKdaConflict) return 409;
  if (error instanceof AxisSubmissionMatchNotFoundError) return 404;
  if (error instanceof AxisOcrMatchMismatchError || isAxisSubmissionError(error, /scoreboard|names do not match/i)) return 422;
  if (error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError) return 400;
  if (error instanceof AxisOcrBusyError) return 503;
  return 503;
}
