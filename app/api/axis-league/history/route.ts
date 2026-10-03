import { loadAxisHistory } from "@/lib/axis-history-sync";

export const runtime = "nodejs";
export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("page") ?? "1";
  const headers = { "Cache-Control": "no-store" };
  if (!/^[1-9]\d{0,5}$/.test(raw) || Number(raw) > 100_000) {
    return Response.json({ error: "invalid_page" }, { status: 400, headers });
  }
  try {
    const data = await loadAxisHistory(Number(raw));
    return Response.json(data, { status: data.available ? 200 : 503, headers });
  } catch (error) {
    console.warn("AXIS history read failed", error);
    return Response.json({ error: "axis_history_unavailable" }, { status: 503, headers });
  }
}
