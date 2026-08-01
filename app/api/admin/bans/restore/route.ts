import {
  getModerationForAids,
  getModerationStore,
  ModerationConflictError,
  ModerationNotFoundError,
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
  const body = await request.json().catch(() => null);
  const confirmed = parseConfirmedAid(body);
  if (!confirmed) {
    return Response.json({ error: "Invalid restore confirmation" }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
  }
  try {
    (await getModerationStore()).restoreManualBan({ aid: confirmed.aid });
    return Response.json(
      { ok: true, moderation: (await getModerationForAids([confirmed.aid]))[0] },
      { headers: ADMIN_NO_STORE_HEADERS }
    );
  } catch (error) {
    if (error instanceof ModerationConflictError) {
      return Response.json({ error: error.message }, { status: 409, headers: ADMIN_NO_STORE_HEADERS });
    }
    if (error instanceof ModerationNotFoundError) {
      return Response.json({ error: error.message }, { status: 404, headers: ADMIN_NO_STORE_HEADERS });
    }
    console.error("admin ban restore failed", error);
    return Response.json({ error: "Restore failed" }, { status: 503, headers: ADMIN_NO_STORE_HEADERS });
  }
}
