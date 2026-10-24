import { requireAdmin } from "@/lib/admin-auth";
import { ADMIN_NO_STORE_HEADERS, rejectInvalidAdminMutation } from "@/lib/admin/mutation";
import { getAxisLeagueStore } from "@/lib/admin/axis-league-db";

export const runtime = "nodejs";
export async function GET() {
  const access = await requireAdmin();
  if (!access.ok) return Response.json({ error: "admin_access_denied" }, { status: access.status, headers: ADMIN_NO_STORE_HEADERS });
  try {
    const store = await getAxisLeagueStore();
    return Response.json({ editors: store.listAxisRoles() }, { headers: ADMIN_NO_STORE_HEADERS });
  }
  catch { return Response.json({ error: "editors_unavailable" }, { status: 503, headers: ADMIN_NO_STORE_HEADERS }); }
}
export async function POST(request: Request) {
  const rejected = await rejectInvalidAdminMutation(request);
  if (rejected) return rejected;
  try {
    const body = await request.json();
    if (!body || typeof body.subject !== "string" || typeof body.enabled !== "boolean"
      || body.role !== undefined && body.role !== null && body.role !== "player" && body.role !== "moderator"
      || body.role === null && body.enabled) throw new TypeError("Invalid editor");
    const store = await getAxisLeagueStore();
    if (body.role !== undefined) store.setAxisRole(body.subject, body.enabled ? body.role : null);
    else store.setKdaEditor(body.subject, body.enabled);
    return Response.json({ ok: true, editors: store.listAxisRoles() }, { headers: ADMIN_NO_STORE_HEADERS });
  } catch (error) {
    const invalid = error instanceof TypeError || error instanceof SyntaxError;
    return Response.json({ error: invalid ? "invalid_editor" : "editors_unavailable" }, { status: invalid ? 400 : 503, headers: ADMIN_NO_STORE_HEADERS });
  }
}
