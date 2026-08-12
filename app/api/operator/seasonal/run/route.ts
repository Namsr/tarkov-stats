import { isOperatorRequest, operatorNoStoreHeaders } from "@/lib/operator-auth";
import {
  getSeasonalOperatorStore,
  type OperatorTaskOutcome,
} from "@/lib/seasonal/operator";
import { isSeasonalRolloutReady, loadSeasonalCycleConfig } from "@/lib/seasonal/config";
import { finalizeSeasonalTaskLifecycle, prepareSeasonalScannerCycle } from "@/lib/seasonal/scanner";

export const runtime = "nodejs";

const OUTCOMES = new Set<OperatorTaskOutcome>([
  "completed", "skipped", "not_found", "rate_limited", "upstream_error", "schema_error",
]);

export async function POST(request: Request) {
  const headers = operatorNoStoreHeaders();
  if (!(await isOperatorRequest(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  }
  if (!isSeasonalRolloutReady()) {
    return Response.json({ error: "Seasonal scanner unavailable" }, { status: 404, headers });
  }
  if (loadSeasonalCycleConfig()?.collectionSource === "json_feed") {
    return Response.json({ error: "Seasonal JSON feed owns collection" }, { status: 404, headers });
  }
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400, headers });
  }
  try {
    const store = await getSeasonalOperatorStore();
    if (body.action === "claim") {
      if (typeof body.cycleId !== "string" || typeof body.owner !== "string") {
        return Response.json({ error: "cycleId and owner are required" }, { status: 400, headers });
      }
      const cycle = loadSeasonalCycleConfig();
      if (!cycle || cycle.cycleId !== body.cycleId) {
        return Response.json({ error: "Seasonal scanner unavailable" }, { status: 409, headers });
      }
      await prepareSeasonalScannerCycle(cycle);
      const run = await store.beginOrResumeRun(body.cycleId, body.owner);
      const claimed = await store.claimNext(run.id, body.owner) as {
        run: { state: string }; task: unknown; retryAt?: number;
      };
      return Response.json(claimed, { headers });
    }
    if (body.action === "outcome") {
      if (
        typeof body.runId !== "number" || typeof body.taskId !== "number" ||
        typeof body.owner !== "string" || typeof body.outcome !== "string" ||
        !OUTCOMES.has(body.outcome as OperatorTaskOutcome) ||
        (body.detail != null && typeof body.detail !== "string")
      ) {
        return Response.json({ error: "Invalid outcome" }, { status: 400, headers });
      }
      const result = await store.recordOutcome({
        runId: body.runId,
        taskId: body.taskId,
        owner: body.owner,
        outcome: body.outcome as OperatorTaskOutcome,
        detail: body.detail as string | null | undefined,
      });
      if (body.outcome === "completed") {
        const cycle = loadSeasonalCycleConfig();
        if (cycle) await finalizeSeasonalTaskLifecycle(cycle, body.taskId).catch((error) =>
          console.error("Seasonal task follow-up failed", error));
      }
      return Response.json(result, { headers });
    }
    return Response.json({ error: "Unsupported action" }, { status: 400, headers });
  } catch (error) {
    console.error("seasonal operator run failed", error);
    return Response.json({ error: "Operator queue unavailable" }, { status: 503, headers });
  }
}
