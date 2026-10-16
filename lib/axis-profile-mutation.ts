import type { AdminAccess } from "@/lib/admin-auth";
import { ADMIN_NO_STORE_HEADERS, rejectInvalidAdminMutation } from "@/lib/admin/mutation";
import { getAxisLeagueStore } from "@/lib/admin/axis-league-db";
import { parseAxisProfile } from "@/lib/axis-league";

/** Share validation and persistence while each route supplies its own access boundary. */
export async function updateAxisProfile(request: Request, authorize: () => Promise<AdminAccess>) {
  const rejected = await rejectInvalidAdminMutation(request, authorize);
  if (rejected) return rejected;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.discordId !== "string" || !/^\d{1,20}$/.test(body.discordId)
    || (body.profile !== null && (typeof body.profile !== "string" || body.profile.length > 400))) {
    return Response.json({ error: "invalid_profile" }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
  }
  const profile = body.profile === null ? null : parseAxisProfile(body.profile);
  if (body.profile !== null && profile === null) return Response.json({ error: "invalid_profile" }, { status: 400, headers: ADMIN_NO_STORE_HEADERS });
  try {
    const store = await getAxisLeagueStore();
    store.setProfile(body.discordId, profile);
    return Response.json({ ok: true, data: store.read() }, { headers: ADMIN_NO_STORE_HEADERS });
  } catch (error) {
    const invalid = error instanceof TypeError || error instanceof RangeError;
    return Response.json({ error: invalid ? "invalid_or_duplicate_profile" : "axis_league_unavailable" },
      { status: invalid ? 400 : 503, headers: ADMIN_NO_STORE_HEADERS });
  }
}
