import { loadAxisLeague } from "@/lib/axis-league-sync";

export const runtime = "nodejs";
export async function GET() {
  try {
    const data = await loadAxisLeague();
    return Response.json(data, { status: data.available ? 200 : 503, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.warn("AXIS League read failed", error);
    return Response.json({ error: "axis_league_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
