import { ADMIN_NO_STORE_HEADERS, rejectInvalidAdminMutation } from "@/lib/admin/mutation";
import { getAxisLeagueStore } from "@/lib/admin/axis-league-db";
import { AxisKdaConflict } from "@/lib/axis-kda";
import { requireAxisKdaEditor } from "@/lib/axis-access";

import { AxisPhotoInputError, type AxisPhotoChange } from "@/lib/axis-match-photo";
import { readAxisPhotoBody, normalizeAxisPhoto } from "@/lib/axis-photo-upload";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const rejected = await rejectInvalidAdminMutation(request, requireAxisKdaEditor);
  if (rejected) return rejected;
  try {
    const body = await readAxisPhotoBody(request) as Record<string, unknown> | null;
    if (!body || !Number.isSafeInteger(body.matchNumber) || Number(body.matchNumber) <= 0) throw new TypeError("Invalid match");
    let photo: AxisPhotoChange | undefined;
    if (body.photo !== undefined) {
      const input = body.photo as { expected?: unknown; data?: unknown } | null;
      if (!input || input.expected !== null && (typeof input.expected !== "string" || !/^[a-f0-9]{64}$/.test(input.expected))
        || input.data !== null && typeof input.data !== "string") throw new AxisPhotoInputError();
      photo = { expected: input.expected as string | null, photo: input.data === null ? null : await normalizeAxisPhoto(input.data) };
      const access = await requireAxisKdaEditor();
      if (!access.ok) return Response.json({ error: "Forbidden" }, { status: access.status, headers: ADMIN_NO_STORE_HEADERS });
    }
    const store = await getAxisLeagueStore();
    const stats = store.setMatchStats(Number(body.matchNumber), body.players as Parameters<typeof store.setMatchStats>[1], body.rounds as Parameters<typeof store.setMatchStats>[2], photo);
    return Response.json({ ok: true, matchNumber: body.matchNumber, ...stats }, { headers: ADMIN_NO_STORE_HEADERS });
  } catch (error) {
    const status = error instanceof AxisKdaConflict ? 409 : error instanceof AxisPhotoInputError ? error.status : error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError ? 400 : 503;
    return Response.json({ error: status === 409 ? "stats_conflict" : status === 413 ? "photo_too_large" : status === 400 ? "invalid_match_stats" : "stats_unavailable" }, { status, headers: ADMIN_NO_STORE_HEADERS });
  }
}
