import { isOperatorRequest, operatorNoStoreHeaders } from "@/lib/operator-auth";
import { getSeasonalOperatorStore } from "@/lib/seasonal/operator";
import { isSeasonalRolloutReady } from "@/lib/seasonal/config";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const headers = operatorNoStoreHeaders();
  if (!(await isOperatorRequest(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  }
  if (!isSeasonalRolloutReady()) {
    return Response.json({ error: "Seasonal scanner unavailable" }, { status: 404, headers });
  }
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (
    !body || body.evidence !== "tarkov_dev_name_search_absence" ||
    !Number.isSafeInteger(body.runId) || !Number.isSafeInteger(body.taskId) ||
    !Number.isSafeInteger(body.aid) || typeof body.owner !== "string" || typeof body.cycleId !== "string"
  ) {
    return Response.json({ error: "Invalid ban confirmation" }, { status: 400, headers });
  }
  try {
    const store = await getSeasonalOperatorStore();
    await store.confirmBanned({
      runId: Number(body.runId), taskId: Number(body.taskId), owner: body.owner,
      aid: Number(body.aid), cycleId: body.cycleId,
    });
    return Response.json({ ok: true }, { headers });
  } catch (error) {
    console.error("operator Seasonal ban confirmation failed", error);
    return Response.json({ error: "Ban confirmation failed" }, { status: 409, headers });
  }
}
