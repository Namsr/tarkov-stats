import { ADMIN_NO_STORE_HEADERS, rejectInvalidAdminMutation } from "@/lib/admin/mutation";
import { getAxisLeagueStore } from "@/lib/admin/axis-league-db";
import { AxisKdaConflict } from "@/lib/axis-kda";
import { googleDisplayName } from "@/lib/auth/google-identity";
import { requireAxisKdaEditor } from "@/lib/axis-access";

import { AxisPhotoInputError, type AxisPhotoChange } from "@/lib/axis-match-photo";
import { readAxisPhotoBody } from "@/lib/axis-photo-upload";
import { axisOcrContextForMatch, axisOcrRosterFingerprint, axisOcrStatsPlayerIds, validateAxisOcrNames, AxisOcrMatchMismatchError } from "@/lib/axis-server-match-validation";
import { recognizeAxisPhotoUpload } from "@/lib/server-axis-ocr";
import { parseAxisOcrNameRows } from "@/lib/axis-match-submission";

export const runtime = "nodejs";


export async function POST(request: Request) {
  const rejected = await rejectInvalidAdminMutation(request, requireAxisKdaEditor);
  if (rejected) return rejected;
  try {
    const body = await readAxisPhotoBody(request) as Record<string, unknown> | null;
    if (!body || !Number.isSafeInteger(body.matchNumber) || Number(body.matchNumber) <= 0) throw new TypeError("Invalid match");
    let photo: AxisPhotoChange | undefined;
    let uploadData: string | undefined;
    let uploadExpected: string | null = null;
    if (body.photo !== undefined) {
      const input = body.photo as { expected?: unknown; data?: unknown } | null;
      if (!input || input.expected !== null && (typeof input.expected !== "string" || !/^[a-f0-9]{64}$/.test(input.expected))
        || input.data !== null && typeof input.data !== "string") throw new AxisPhotoInputError();
      uploadExpected = input.expected === undefined ? null : input.expected as string | null;
      if (input.data === null) photo = { expected: uploadExpected, photo: null };
      else uploadData = input.data as string;
    }
    const access = await requireAxisKdaEditor();
    if (!access.ok) return Response.json({ error: "Forbidden" }, { status: access.status, headers: ADMIN_NO_STORE_HEADERS });
    const store = await getAxisLeagueStore();
    let actorAccess = access;
    let review;
    let rosterFingerprint: string | undefined;
    if (uploadData !== undefined) {
      const match = store.readMatchHistory(Number(body.matchNumber)).matches[0];
      if (!match || match.number !== Number(body.matchNumber)) throw new RangeError("Unknown match");
      rosterFingerprint = axisOcrRosterFingerprint(match);
      const context = await axisOcrContextForMatch(match);
      const recognized = await recognizeAxisPhotoUpload(uploadData);
      photo = { expected: uploadExpected, photo: recognized.photo };
      const result = recognized.result;
      const validation = validateAxisOcrNames(result, context);
      const statIds = axisOcrStatsPlayerIds(result, validation);
      const missingDiscordIds = context.participants.filter(({ discordId }) => !statIds.has(discordId)).map(({ discordId }) => discordId);
      const { recognizedNames, unmatchedNames } = validation;
      const refreshedAccess = await requireAxisKdaEditor();
      if (!refreshedAccess.ok) return Response.json({ error: "Forbidden" }, { status: refreshedAccess.status, headers: ADMIN_NO_STORE_HEADERS });
      actorAccess = refreshedAccess;
      review = { matchNumber: Number(body.matchNumber), photoRevision: recognized.photo.revision, recognizedNames, unmatchedNames, missingDiscordIds, nameRows: parseAxisOcrNameRows(result.rows), uploadedBy: refreshedAccess.user.sub, uploadedAt: Date.now() };
    }
    const stats = store.setMatchStats(Number(body.matchNumber), body.players as Parameters<typeof store.setMatchStats>[1], body.rounds as Parameters<typeof store.setMatchStats>[2], photo, { sub: actorAccess.user.sub, name: googleDisplayName(actorAccess.user) }, review, rosterFingerprint);
    return Response.json({ ok: true, matchNumber: body.matchNumber, ...stats }, { headers: ADMIN_NO_STORE_HEADERS });
  } catch (error) {
    const detectedMismatch = error instanceof AxisOcrMatchMismatchError || error instanceof Error && /scoreboard|names do not match/i.test(error.message);
    const status = error instanceof AxisKdaConflict ? 409 : error instanceof AxisPhotoInputError ? error.status : detectedMismatch ? 422 : error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError ? 400 : 503;
    return Response.json({ error: status === 409 ? "stats_conflict" : status === 413 ? "photo_too_large" : status === 422 ? "screenshot_match_mismatch" : status === 400 ? "invalid_match_stats" : "stats_unavailable" }, { status, headers: ADMIN_NO_STORE_HEADERS });
  }
}
