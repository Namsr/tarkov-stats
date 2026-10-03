import { requireAdmin } from "@/lib/admin-auth";
import { ADMIN_NO_STORE_HEADERS, rejectInvalidAdminMutation } from "@/lib/admin/mutation";
import { getAxisLeagueStore } from "@/lib/admin/axis-league-db";
import { loadAxisLeague } from "@/lib/axis-league-sync";
import { parseAxisProfile } from "@/lib/axis-league";

export const runtime = "nodejs";
export async function GET() {
  const access = await requireAdmin();
  if (!access.ok) return Response.json({ error: "admin_access_denied" }, { status: access.status, headers: ADMIN_NO_STORE_HEADERS });
  try { return Response.json(await loadAxisLeague(), { headers: ADMIN_NO_STORE_HEADERS }); }
  catch { return Response.json({ error: "axis_league_unavailable" }, { status: 503, headers: ADMIN_NO_STORE_HEADERS }); }
}
export async function POST(request: Request) {
  const rejected = await rejectInvalidAdminMutation(request);
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
