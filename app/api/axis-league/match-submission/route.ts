import { ADMIN_NO_STORE_HEADERS, rejectInvalidAdminMutation } from "@/lib/admin/mutation";
import { requireAxisScreenshotSubmitter } from "@/lib/axis-access";
import { googleDisplayName } from "@/lib/auth/google-identity";
import { readAxisPhotoBody } from "@/lib/axis-photo-upload";
import { axisSubmissionStatus, submitAxisScreenshot } from "@/lib/axis-submission-service";

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
    if (!access.ok) return Response.json({ error: access.status === 401 ? "Unauthorized" : "Forbidden" }, { status: access.status, headers: ADMIN_NO_STORE_HEADERS });
    const saved = await submitAxisScreenshot({
      matchNumber,
      photoData: photoInput.data,
      actor: { sub: access.user.sub, name: googleDisplayName(access.user) },
      // OCR is deliberately performed before this second check.  A revoked
      // browser session must not be able to commit a result after revocation.
      reauthorize: async () => {
        const refreshed = await requireAxisScreenshotSubmitter();
        return refreshed.ok
          ? { ok: true, actor: { sub: refreshed.user.sub, name: googleDisplayName(refreshed.user) } }
          : refreshed;
      },
    });
    // The upload response is deliberately not a moderation read. In particular,
    // do not return the review aggregate or uploader identities from other photos
    // to a player submitting a screenshot.
    const { players, rounds: savedRounds, photo: savedPhoto } = saved;
    return Response.json({ ok: true, matchNumber, players, rounds: savedRounds, photo: savedPhoto }, { headers: ADMIN_NO_STORE_HEADERS });
  } catch (error) {
    const status = axisSubmissionStatus(error);
    return Response.json({ error: status === 404 ? "match_not_found" : status === 413 ? "photo_too_large" : status === 400 ? "invalid_submission" : status === 409 ? "submission_conflict" : status === 422 ? "screenshot_match_mismatch" : "ocr_unavailable" }, { status, headers: ADMIN_NO_STORE_HEADERS });
  }
}
