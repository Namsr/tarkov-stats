import { revalidateTag } from "next/cache";
import { isOperatorRequest, operatorNoStoreHeaders } from "@/lib/operator-auth";
import { SEASONAL_AVERAGE_CACHE_TAG } from "@/lib/average-cache";
import { isSeasonalRolloutReady, loadSeasonalCycleConfig } from "@/lib/seasonal/config";
import { fetchSeasonalPayload } from "@/lib/seasonal/fetch";
import { resolveSeasonalProfile } from "@/lib/seasonal/profile-service";
import {
  getSeasonalOperatorStore,
  type ProgressionRefreshOutcome,
} from "@/lib/seasonal/operator";
import { refreshProgressionAfterCapture } from "@/lib/seasonal/daily-aggregates";
import { recordSeasonalCaptureLifecycle } from "@/lib/seasonal/scanner";
import { getSeasonalStore } from "@/lib/seasonal/storage";
import { validateSeasonalProfile } from "@/lib/seasonal-upstream";

export const runtime = "nodejs";

const OUTCOMES = new Set<ProgressionRefreshOutcome>(["completed", "skipped", "not_found"]);
const SUCCESSFUL_CAPTURE_STATES = new Set(["progression", "duplicate", "reset", "schema_anomaly"]);

export async function POST(request: Request) {
  const headers = operatorNoStoreHeaders();
  if (!(await isOperatorRequest(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  }
  if (!isSeasonalRolloutReady()) {
    return Response.json({ error: "Seasonal refresh unavailable" }, { status: 404, headers });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400, headers });
  }

  const cycle = loadSeasonalCycleConfig();
  const owner = typeof body.owner === "string" ? body.owner : "";
  if (!cycle || !owner) return Response.json({ error: "Active Seasonal cycle is required" }, { status: 409, headers });
  if (body.cycleId != null && body.cycleId !== cycle.cycleId) {
    return Response.json({ error: "Seasonal cycle changed" }, { status: 409, headers });
  }

  try {
    const store = await getSeasonalOperatorStore();
    if (body.action === "claim") {
      const result = await store.beginOrResumeProgressionRefreshRun(cycle.cycleId, owner);
      const claim = await store.claimNextProgressionRefresh(result.run.id, owner);
      return Response.json({ cycleId: cycle.cycleId, ...claim }, { headers });
    }

    const runId = Number(body.runId);
    const candidateId = Number(body.candidateId);
    const aid = Number(body.aid);
    if (!Number.isSafeInteger(runId) || runId <= 0 ||
        !Number.isSafeInteger(candidateId) || candidateId <= 0 ||
        !Number.isSafeInteger(aid) || aid <= 0) {
      return Response.json({ error: "Invalid Seasonal refresh candidate" }, { status: 400, headers });
    }

    if (body.action === "skip") {
      const outcome = typeof body.outcome === "string" ? body.outcome : "skipped";
      if (!OUTCOMES.has(outcome as ProgressionRefreshOutcome) || outcome === "completed") {
        return Response.json({ error: "Invalid Seasonal refresh outcome" }, { status: 400, headers });
      }
      return Response.json(await store.recordProgressionRefreshOutcome({
        runId, candidateId, aid, cycleId: cycle.cycleId, owner,
        outcome: outcome as "skipped" | "not_found",
      }), { headers });
    }

    if (body.action !== "capture") {
      return Response.json({ error: "Unsupported Seasonal refresh action" }, { status: 400, headers });
    }
    const lease = await store.activeProgressionRefreshLease({
      runId, candidateId, aid, cycleId: cycle.cycleId, owner,
    });
    if (!lease) return Response.json({ error: "Active Seasonal refresh lease not found" }, { status: 409, headers });

    const result = await resolveSeasonalProfile(
      { aid, cycleId: cycle.cycleId, force: true },
      {
        loadCycle: loadSeasonalCycleConfig,
        validatePayload: (payload, currentCycle) => validateSeasonalProfile(payload, {
          enabled: true,
          confirmedContract: currentCycle.upstreamContract,
          cycleId: currentCycle.cycleId,
          seasonStartsAt: currentCycle.startsAt,
          seasonEndsAt: currentCycle.endsAt,
        }),
        fetchPayload: ({ aid: profileAid }) => fetchSeasonalPayload(profileAid, { force: true }),
        getStore: getSeasonalStore,
        afterCapture: async ({ cycle: currentCycle, profile, capture, observedAt }) => {
          await recordSeasonalCaptureLifecycle(currentCycle, profile, capture, "task", observedAt);
          if (capture.inserted) {
            await refreshProgressionAfterCapture("seasonal", currentCycle.cycleId, profile.counters.pmcRaids, { force: true });
          }
        },
      },
    );
    if (!result.ok) return Response.json({ error: result.error }, { status: result.status, headers });
    if (!SUCCESSFUL_CAPTURE_STATES.has(result.capture.status)) {
      return Response.json({ error: "Seasonal snapshot was not captured", state: result.capture.status }, { status: 409, headers });
    }

    await store.recordProgressionRefreshOutcome({
      runId, candidateId, aid, cycleId: cycle.cycleId, owner, outcome: "completed",
    });
    if (result.capture.inserted) revalidateTag(SEASONAL_AVERAGE_CACHE_TAG, { expire: 0 });
    return Response.json({
      state: result.capture.inserted ? "updated" : result.capture.status,
      profileUpdatedAt: result.profile.profileUpdatedAt,
      capture: result.capture,
    }, { headers });
  } catch (error) {
    console.error("seasonal progression refresh failed", error);
    return Response.json({ error: "Seasonal progression refresh failed" }, { status: 503, headers });
  }
}
