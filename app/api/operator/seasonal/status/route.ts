import { isOperatorRequest, operatorNoStoreHeaders } from "@/lib/operator-auth";
import { getSeasonalOperatorStore } from "@/lib/seasonal/operator";
import { isSeasonalRolloutReady } from "@/lib/seasonal/config";

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
  try {
    const store = await getSeasonalOperatorStore();
    return Response.json(await store.status(cycleId), { headers });
  } catch (error) {
    console.error("seasonal operator status failed", error);
    return Response.json({ error: "Operator status unavailable" }, { status: 503, headers });
  }
}
