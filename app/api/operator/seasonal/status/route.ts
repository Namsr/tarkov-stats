import { isOperatorRequest, operatorNoStoreHeaders } from "@/lib/operator-auth";
import { getSeasonalOperatorStore } from "@/lib/seasonal/operator";
import { isSeasonalRolloutReady, loadSeasonalCycleConfig } from "@/lib/seasonal/config";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const headers = operatorNoStoreHeaders();
  if (!(await isOperatorRequest(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  }
  if (!isSeasonalRolloutReady()) {
    return Response.json({ error: "Seasonal scanner unavailable" }, { status: 404, headers });
  }
  const cycleId = new URL(request.url).searchParams.get("cycleId");
  if (!cycleId) {
    return Response.json({ error: "cycleId is required" }, { status: 400, headers });
  }
  // `store.status` only checks the cycle-id syntax and would report a malformed
  // value as an outage, so a bad request stays a 400 here.
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(cycleId)) {
    return Response.json({ error: "Invalid cycleId" }, { status: 400, headers });
  }
  const cycle = loadSeasonalCycleConfig();
  if (!cycle || cycle.cycleId !== cycleId) {
    return Response.json({ error: "Seasonal cycle changed" }, { status: 409, headers });
  }
  try {
    const store = await getSeasonalOperatorStore();
    return Response.json(await store.status(cycleId), { headers });
  } catch (error) {
    console.error("seasonal operator status failed", error);
    return Response.json({ error: "Operator status unavailable" }, { status: 503, headers });
  }
}
