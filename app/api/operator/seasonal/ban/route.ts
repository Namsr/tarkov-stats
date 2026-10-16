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
    !Number.isSafeInteger(body.runId) || (body.runId as number) <= 0 ||
    !Number.isSafeInteger(body.taskId) || (body.taskId as number) <= 0 ||
    !Number.isSafeInteger(body.aid) || (body.aid as number) <= 0 ||
    typeof body.owner !== "string" || body.owner.trim() === "" ||
    typeof body.cycleId !== "string" || body.cycleId.trim() === ""
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
    const message = error instanceof Error ? error.message : String(error);
    if (message === "active ban-check lease not found" || message === "Seasonal profile not found") {
      return Response.json({ error: "Ban confirmation failed" }, { status: 409, headers });
    }
    console.error("operator Seasonal ban confirmation failed", error);
    return Response.json({ error: "Ban confirmation failed" }, { status: 503, headers });
  }
}
