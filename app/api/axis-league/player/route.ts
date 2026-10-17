import { getAxisLeagueStore } from "@/lib/admin/axis-league-db";
import { parsePlayerId } from "@/lib/player-id";

export const runtime = "nodejs";

/** Read only the local import; the existing Axis worker owns upstream synchronization. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const aid = parsePlayerId(params.get("aid") ?? "");
  const season = params.get("season") ?? "current", page = params.get("page") ?? "1", result = params.get("result") ?? "all";
  const headers = { "Cache-Control": "no-store" };
  if (aid == null || !/^(?:current|all|match-[1-9]\d{0,8})$/.test(season) || !/^[1-9]\d{0,5}$/.test(page)
    || Number(page) > 100_000 || !["all", "win", "loss"].includes(result)) {
    return Response.json({ error: "invalid_axis_player" }, { status: 400, headers });
  }
  try {
    const data = (await getAxisLeagueStore()).readPlayerProfile(aid, season, Number(page), result);
    return Response.json(data ?? { error: "axis_player_not_linked" }, { status: data ? 200 : 404, headers });
  } catch (error) {
    if (error instanceof RangeError) return Response.json({ error: "invalid_season" }, { status: 400, headers });
    console.warn("AXIS player read failed", error);
    return Response.json({ error: "axis_player_unavailable" }, { status: 503, headers });
  }
}
