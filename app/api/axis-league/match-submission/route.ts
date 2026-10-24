import { ADMIN_NO_STORE_HEADERS, rejectInvalidAdminMutation } from "@/lib/admin/mutation";
import { getAxisLeagueStore } from "@/lib/admin/axis-league-db";
import { requireAxisScreenshotSubmitter } from "@/lib/axis-access";
import { googleDisplayName } from "@/lib/auth/google-identity";
import { readAxisPhotoBody } from "@/lib/axis-photo-upload";
import { AxisPhotoInputError } from "@/lib/axis-match-photo";
import { AxisKdaConflict } from "@/lib/axis-kda";
import { parseAxisOcrCounter } from "@/lib/axis-ocr";
import { axisOcrContextForMatch, axisOcrRosterFingerprint, axisOcrStatsPlayerIds, validateAxisOcrNames, AxisOcrMatchMismatchError } from "@/lib/axis-server-match-validation";
import { AxisOcrBusyError, recognizeAxisPhotoUpload } from "@/lib/server-axis-ocr";

export const runtime = "nodejs";

function readMatchNumber(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new TypeError("Invalid match number");
  return Number(value);
}

export async function POST(request: Request) {
  const rejected = await rejectInvalidAdminMutation(request, requireAxisScreenshotSubmitter);
  if (rejected) return rejected;
  try {
    const body = await readAxisPhotoBody(request) as Record<string, unknown> | null;
    if (!body) throw new TypeError("Invalid submission");
    const matchNumber = readMatchNumber(body.matchNumber);
    const photoInput = body.photo as { expected?: unknown; data?: unknown } | null;
    if (!photoInput || typeof photoInput.data !== "string" || photoInput.data.length === 0
      || photoInput.expected !== undefined && photoInput.expected !== null
        && (typeof photoInput.expected !== "string" || !/^[a-f0-9]{64}$/.test(photoInput.expected))) throw new TypeError("Invalid submission photo");
    const access = await requireAxisScreenshotSubmitter();
    if (!access.ok) return Response.json({ error: "Forbidden" }, { status: access.status, headers: ADMIN_NO_STORE_HEADERS });
    const store = await getAxisLeagueStore();
    const match = store.readMatchHistory(matchNumber).matches[0];
    if (!match || match.number !== matchNumber) return Response.json({ error: "match_not_found" }, { status: 404, headers: ADMIN_NO_STORE_HEADERS });
    const context = await axisOcrContextForMatch(match);
    const { photo, result } = await recognizeAxisPhotoUpload(photoInput.data);
    const validation = validateAxisOcrNames(result, context);
    const { recognizedNames, unmatchedNames } = validation;
    const safety = validation.safety;
    const assigned = new Set<string>();
    const changes = [] as { discordId: string; kda: { kills: number; deaths: number; assists: number }; expected: null }[];
    for (const row of result.rows) {
      const discordId = safety.safeAssignments[row.id];
      if (!discordId || safety.duplicateIds.has(discordId) || safety.blockedKdaSides.has(row.side) || assigned.has(discordId)) continue;
      const kills = parseAxisOcrCounter(row.kills), deaths = parseAxisOcrCounter(row.deaths), assists = parseAxisOcrCounter(row.assists);
      if (kills === null || deaths === null || assists === null) continue;
      assigned.add(discordId);
      changes.push({ discordId, kda: { kills, deaths, assists }, expected: null });
    }
    let rounds;
    const left = parseAxisOcrCounter(result.score.left), right = parseAxisOcrCounter(result.score.right);
    if (left !== null && right !== null) rounds = { score: validation.leftTeam === 0 ? { a: left, b: right } : { a: right, b: left }, expected: null };
    const statIds = axisOcrStatsPlayerIds(result, validation);
    const missingDiscordIds = context.participants.filter(({ discordId }) => !statIds.has(discordId)).map(({ discordId }) => discordId);
    const refreshedAccess = await requireAxisScreenshotSubmitter();
    if (!refreshedAccess.ok) return Response.json({ error: "Forbidden" }, { status: refreshedAccess.status, headers: ADMIN_NO_STORE_HEADERS });
    const saved = store.submitAxisMatch(matchNumber, photo, changes, rounds, { recognizedNames, unmatchedNames, missingDiscordIds }, { sub: refreshedAccess.user.sub, name: googleDisplayName(refreshedAccess.user) }, axisOcrRosterFingerprint(match));
    // The upload response is deliberately not a moderation read. In particular,
    // do not return the review aggregate or uploader identities from other photos
    // to a player submitting a screenshot.
    const { players, rounds: savedRounds, photo: savedPhoto } = saved;
    return Response.json({ ok: true, matchNumber, players, rounds: savedRounds, photo: savedPhoto }, { headers: ADMIN_NO_STORE_HEADERS });
  } catch (error) {
    const detectedMismatch = error instanceof AxisOcrMatchMismatchError || error instanceof Error && /scoreboard|names do not match/i.test(error.message);
    const status = error instanceof AxisPhotoInputError ? error.status : error instanceof AxisKdaConflict ? 409 : error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError ? 400 : detectedMismatch ? 422 : error instanceof AxisOcrBusyError ? 503 : 503;
    return Response.json({ error: status === 413 ? "photo_too_large" : status === 400 ? "invalid_submission" : status === 409 ? "submission_conflict" : status === 422 ? "screenshot_match_mismatch" : "ocr_unavailable" }, { status, headers: ADMIN_NO_STORE_HEADERS });
  }
}
