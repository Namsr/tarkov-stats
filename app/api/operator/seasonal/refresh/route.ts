import { revalidateTag } from "next/cache";
import { isOperatorRequest, operatorNoStoreHeaders } from "@/lib/operator-auth";
import { SEASONAL_AVERAGE_CACHE_TAG } from "@/lib/average-cache";
import { isSeasonalRolloutReady, loadSeasonalCycleConfig } from "@/lib/seasonal/config";
import { markAveragePublicationDirty, seasonalPublicationScope } from "@/lib/average-publication";
import { fetchSeasonalPayload } from "@/lib/seasonal/fetch";
import { resolveSeasonalProfile } from "@/lib/seasonal/profile-service";
import {
  getSeasonalOperatorStore,
  normalizeProgressionRefreshCandidates,
  type ProgressionRefreshOutcome,
} from "@/lib/seasonal/operator";
import { recordSeasonalCaptureLifecycle } from "@/lib/seasonal/scanner";
import { getSeasonalStore } from "@/lib/seasonal/storage";
import { validateSeasonalProfile } from "@/lib/seasonal-upstream";

export const runtime = "nodejs";

const OUTCOMES = new Set<ProgressionRefreshOutcome>(["completed", "skipped", "not_found"]);
const SUCCESSFUL_CAPTURE_STATES = new Set([
  "baseline",
  "progression",
  "duplicate",
  "stale",
  "stored",
  "reset",
  "schema_anomaly",
]);
const fetchSeasonalPayloadCompat = fetchSeasonalPayload as (
  aid: number,
  options?: { force?: boolean },
) => Promise<unknown>;

/**
 * A refresh can observe a transient upstream/schema failure after the account
 * was already captured. Keep that durable snapshot eligible for queue
 * completion instead of turning a known account into `not_found`.
 */
async function storedSeasonalVersion(aid: number, cycleId: string): Promise<number | null> {
  try {
    const seasonal = await getSeasonalStore();
    if (!seasonal) return null;
    const profile = await seasonal.getProfile({ mode: "seasonal", cycleId, aid });
    if (profile) {
      return profile.confirmedBanned ? null : profile.profileUpdatedAt;
    }
    const snapshot = await seasonal.latestSnapshot({ mode: "seasonal", cycleId, aid });
    return snapshot?.profileUpdatedAt ?? null;
  } catch {
    return null;
  }
}

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
    if (body.action === "restart") {
      if (!Array.isArray(body.candidates)) {
        return Response.json({ error: "Seasonal candidate list is required" }, { status: 400, headers });
      }
      try {
        const candidates = normalizeProgressionRefreshCandidates(body.candidates.map((candidate) => {
          const value = candidate as Record<string, unknown>;
          return { aid: Number(value?.aid), updatedAt: Number(value?.updatedAt) };
        }));
        const result = await store.restartProgressionRefreshRun(cycle.cycleId, owner, candidates);
        return Response.json({
          cycleId: cycle.cycleId,
          received: body.candidates.length,
          ...result,
        }, { headers });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return Response.json({ error: message }, { status: 400, headers });
      }
    }
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

    if (body.action === "release") {
      return Response.json(await store.releaseProgressionRefreshLease({
        runId, candidateId, aid, cycleId: cycle.cycleId, owner,
      }), { headers });
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
        fetchPayload: ({ aid: profileAid }) => fetchSeasonalPayloadCompat(profileAid, { force: true }),
        getStore: getSeasonalStore,
        afterCapture: async ({ cycle: currentCycle, profile, capture, observedAt }) => {
          await recordSeasonalCaptureLifecycle(currentCycle, profile, capture, "task", observedAt);
        },
      },
    );
    if (!result.ok) {
      const storedVersion = await storedSeasonalVersion(aid, cycle.cycleId);
      if (storedVersion !== null) {
        await store.recordProgressionRefreshOutcome({
          runId, candidateId, aid, cycleId: cycle.cycleId, owner, outcome: "completed",
        });
        return Response.json({
          state: "stored",
          profileUpdatedAt: storedVersion,
          capture: { inserted: false, status: "stored" },
        }, { headers });
      }
      // A 404 with no durable Seasonal row is a genuine missing profile. A
      // validation/schema failure remains visible to the operator instead of
      // silently discarding a potentially valid account.
      if (result.status === 404) {
        const outcome = await store.recordProgressionRefreshOutcome({
          runId, candidateId, aid, cycleId: cycle.cycleId, owner, outcome: "not_found",
        });
        return Response.json({
          ...outcome,
          state: "not_found",
          capture: { inserted: false, status: "not_found" },
        }, { headers });
      }
      return Response.json({ error: result.error }, { status: result.status, headers });
    }
    if (!SUCCESSFUL_CAPTURE_STATES.has(result.capture.status)) {
      return Response.json({ error: "Seasonal snapshot was not captured", state: result.capture.status }, { status: 409, headers });
    }

    await store.recordProgressionRefreshOutcome({
      runId, candidateId, aid, cycleId: cycle.cycleId, owner, outcome: "completed",
    });
    if (result.capture.inserted) {
      revalidateTag(SEASONAL_AVERAGE_CACHE_TAG, "max");
      await markAveragePublicationDirty(seasonalPublicationScope(cycle.cycleId));
    }
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
