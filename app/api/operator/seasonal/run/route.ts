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
    // `request.json()` resolves for a literal `null` body, so the parsed value has
    // to be checked before the `action` reads below can throw a TypeError.
    const parsed: unknown = await request.json();
    if (typeof parsed !== "object" || parsed === null) throw new TypeError("body is not an object");
    body = parsed as Record<string, unknown>;
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
      // A claim pins the cycle, but a five-minute lease can expire before the
      // operator reports back, and a retired cycle keeps its run and tasks. Both
      // make `recordOutcome` throw before it writes, so the outcome row and the
      // `consecutive_errors` counter that stops a wedged run never happen. The
      // same lease check the capture route uses keeps them reported as conflicts.
      const cycle = loadSeasonalCycleConfig();
      const lease = await store.activeLease({
        runId: body.runId, taskId: body.taskId, owner: body.owner,
      });
      if (!cycle || !lease || lease.cycleId !== cycle.cycleId) {
        return Response.json({ error: "Active Seasonal lease not found" }, { status: 409, headers });
      }
      let result: Awaited<ReturnType<typeof store.recordOutcome>>;
      try {
        result = await store.recordOutcome({
          runId: body.runId,
          taskId: body.taskId,
          owner: body.owner,
          outcome: body.outcome as OperatorTaskOutcome,
          detail: body.detail as string | null | undefined,
        });
      } catch (error) {
        // The lease can still lapse between the check above and this write, so
        // the store's own guards stay mapped. Anything else is a real outage and
        // keeps falling through to the 503.
        const message = error instanceof Error ? error.message : String(error);
        if (message === "outcome detail is too long") {
          return Response.json({ error: message }, { status: 400, headers });
        }
        if (message === "leased task not found for active run") {
          return Response.json({ error: "Active Seasonal lease not found" }, { status: 409, headers });
        }
        throw error;
      }
      if (body.outcome === "completed") {
        // `cycle` is the cycle this task was just reported against, so the
        // follow-up lands in the same cycle instead of being filtered away.
        await finalizeSeasonalTaskLifecycle(cycle, body.taskId).catch((error) =>
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
