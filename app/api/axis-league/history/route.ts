import { loadAxisHistory, loadAxisSeasonHistory } from "@/lib/axis-history-sync";
import { after } from "next/server";

export const runtime = "nodejs";
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const raw = params.get("page") ?? "1";
  const match = params.get("match");
  const season = params.get("season");
  const map = params.get("map") ?? undefined;
  const headers = { "Cache-Control": "no-store" };
  if (map != null && (!map.trim() || map.length > 200 || /[\u0000-\u001f\u007f]/.test(map) || match != null)) {
    return Response.json({ error: "invalid_map" }, { status: 400, headers });
  }
  if (match != null && (!/^[1-9]\d{0,8}$/.test(match) || raw !== "1" || season != null && season !== "all")) {
    return Response.json({ error: "invalid_match" }, { status: 400, headers });
  }
  if (!/^[1-9]\d{0,5}$/.test(raw) || Number(raw) > 100_000 || season != null && !/^(?:current|all|match-[1-9]\d{0,8})$/.test(season)) {
    return Response.json({ error: "invalid_page" }, { status: 400, headers });
  }
  try {
    const data = match != null ? await loadAxisSeasonHistory(1, "all", after, Number(match)) : map != null ? await loadAxisSeasonHistory(Number(raw), season ?? "all", after, undefined, map) : season == null ? await loadAxisHistory(Number(raw), after) : await loadAxisSeasonHistory(Number(raw), season, after);
    return Response.json(data, { status: !data.available ? 503 : match != null && data.matches.length === 0 ? 404 : 200, headers });
  } catch (error) {
    if (error instanceof RangeError) return Response.json({ error: "invalid_season" }, { status: 400, headers });
    console.warn("AXIS history read failed", error);
    return Response.json({ error: "axis_history_unavailable" }, { status: 503, headers });
  }
}
