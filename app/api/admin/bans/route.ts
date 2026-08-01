import {
  getModerationForAids,
  getModerationStore,
  ModerationConflictError,
} from "@/lib/admin/moderation-db";
import {
  ADMIN_NO_STORE_HEADERS,
  parseConfirmedAid,
  rejectInvalidAdminMutation,
} from "@/lib/admin/mutation";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const rejected = await rejectInvalidAdminMutation(request);
  if (rejected) return rejected;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const confirmed = parseConfirmedAid(body);
  if (!confirmed || typeof body?.reason !== "string" || !body.reason.trim()) {
    return Response.json({ error: "Invalid ban confirmation" }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
  }
  try {
    (await getModerationStore()).confirmManualBan({ aid: confirmed.aid, reason: body.reason });
    return Response.json(
      { ok: true, moderation: (await getModerationForAids([confirmed.aid]))[0] },
      { headers: ADMIN_NO_STORE_HEADERS }
    );
  } catch (error) {
    if (error instanceof TypeError) {
      return Response.json({ error: error.message }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
    }
    if (error instanceof ModerationConflictError) {
      return Response.json({ error: error.message }, { status: 409, headers: ADMIN_NO_STORE_HEADERS });
    }
    console.error("admin ban failed", error);
    return Response.json({ error: "Ban failed" }, { status: 503, headers: ADMIN_NO_STORE_HEADERS });
  }
}
