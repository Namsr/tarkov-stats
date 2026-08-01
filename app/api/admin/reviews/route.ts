import { getModerationForAids, getModerationStore, type AdminReviewStatus } from "@/lib/admin/moderation-db";
import { ADMIN_NO_STORE_HEADERS, rejectInvalidAdminMutation } from "@/lib/admin/mutation";

export const runtime = "nodejs";

export async function PATCH(request: Request) {
  const rejected = await rejectInvalidAdminMutation(request);
  if (rejected) return rejected;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const aid = Number(body?.aid);
  const status = body?.status as AdminReviewStatus | undefined;
  if (
    !body || !Number.isSafeInteger(aid) || aid <= 0 ||
    !(["reviewed", "false_positive"] as const).includes(
      status as "reviewed" | "false_positive"
    ) ||
    !(body.note == null || typeof body.note === "string")
  ) {
    return Response.json({ error: "Invalid review" }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
  }
  try {
    (await getModerationStore()).setReview({
      aid,
      status: status as Exclude<AdminReviewStatus, "new">,
      note: body.note as string | null | undefined,
    });
    return Response.json(
      { ok: true, moderation: (await getModerationForAids([aid]))[0] },
      { headers: ADMIN_NO_STORE_HEADERS }
    );
  } catch (error) {
    if (error instanceof TypeError) {
      return Response.json({ error: error.message }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
    }
    console.error("admin review failed", error);
    return Response.json({ error: "Review failed" }, { status: 503, headers: ADMIN_NO_STORE_HEADERS });
  }
}
