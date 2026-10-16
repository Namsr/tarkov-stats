import { requireAdmin } from "@/lib/admin-auth";
import { ADMIN_NO_STORE_HEADERS } from "@/lib/admin/mutation";
import { loadAxisLeague } from "@/lib/axis-league-sync";
import { after } from "next/server";
import { updateAxisProfile } from "@/lib/axis-profile-mutation";

export const runtime = "nodejs";
export async function GET() {
  const access = await requireAdmin();
  if (!access.ok) return Response.json({ error: "admin_access_denied" }, { status: access.status, headers: ADMIN_NO_STORE_HEADERS });
  try { return Response.json(await loadAxisLeague(after), { headers: ADMIN_NO_STORE_HEADERS }); }
  catch { return Response.json({ error: "axis_league_unavailable" }, { status: 503, headers: ADMIN_NO_STORE_HEADERS }); }
}
export async function POST(request: Request) {
  return updateAxisProfile(request, requireAdmin);
}
