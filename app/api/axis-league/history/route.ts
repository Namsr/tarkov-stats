import { loadAxisHistory, loadAxisSeasonHistory } from "@/lib/axis-history-sync";
import { after } from "next/server";

export const runtime = "nodejs";
export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("page") ?? "1";
  const season = new URL(request.url).searchParams.get("season");
  const headers = { "Cache-Control": "no-store" };
  if (!/^[1-9]\d{0,5}$/.test(raw) || Number(raw) > 100_000 || season != null && !/^(?:current|all|match-[1-9]\d{0,8})$/.test(season)) {
    return Response.json({ error: "invalid_page" }, { status: 400, headers });
  }
  try {
    const data = season == null ? await loadAxisHistory(Number(raw), after) : await loadAxisSeasonHistory(Number(raw), season, after);
    return Response.json(data, { status: data.available ? 200 : 503, headers });
  } catch (error) {
    if (error instanceof RangeError) return Response.json({ error: "invalid_season" }, { status: 400, headers });
    console.warn("AXIS history read failed", error);
    return Response.json({ error: "axis_history_unavailable" }, { status: 503, headers });
  }
}
