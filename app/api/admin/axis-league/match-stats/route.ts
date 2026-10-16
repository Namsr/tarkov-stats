import { ADMIN_NO_STORE_HEADERS, rejectInvalidAdminMutation } from "@/lib/admin/mutation";
import { getAxisLeagueStore } from "@/lib/admin/axis-league-db";
import { AxisKdaConflict } from "@/lib/axis-kda";
import { requireAxisKdaEditor } from "@/lib/axis-access";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const rejected = await rejectInvalidAdminMutation(request, requireAxisKdaEditor);
  if (rejected) return rejected;
  try {
    const body = await request.json();
    if (!body || !Number.isSafeInteger(body.matchNumber) || body.matchNumber <= 0) throw new TypeError("Invalid match");
    const store = await getAxisLeagueStore();
    const stats = store.setMatchStats(body.matchNumber, body.players, body.rounds);
    return Response.json({ ok: true, matchNumber: body.matchNumber, ...stats }, { headers: ADMIN_NO_STORE_HEADERS });
  } catch (error) {
    const status = error instanceof AxisKdaConflict ? 409 : error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError ? 400 : 503;
    return Response.json({ error: status === 409 ? "stats_conflict" : status === 400 ? "invalid_match_stats" : "stats_unavailable" }, { status, headers: ADMIN_NO_STORE_HEADERS });
  }
}
