import { revalidateTag } from "next/cache";
import { isOperatorRequest, operatorNoStoreHeaders } from "@/lib/operator-auth";
import { SEASONAL_AVERAGE_CACHE_TAG } from "@/lib/average-cache";
import { isSeasonalCollectorReady, loadSeasonalCycleConfig } from "@/lib/seasonal/config";
import { fetchSeasonalPayload } from "@/lib/seasonal/fetch";
import { resolveSeasonalProfile } from "@/lib/seasonal/profile-service";
import { validateSeasonalProfile } from "@/lib/seasonal-upstream";
import { getSeasonalStore } from "@/lib/seasonal/storage";
import { recordSeasonalCaptureLifecycle } from "@/lib/seasonal/scanner";
import { markAveragePublicationDirty, seasonalPublicationScope } from "@/lib/average-publication";

export const runtime = "nodejs";

/**
 * Authenticated capture boundary for the JSON-feed collector. The collector
 * owns feed polling and queue state; this endpoint owns the validated profile
 * write so it shares the exact same Seasonal storage path as the UI/operator.
 */
export async function POST(request: Request) {
  const headers = operatorNoStoreHeaders();
  if (!(await isOperatorRequest(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  }

  if (!isSeasonalCollectorReady()) {
    return Response.json({ error: "Seasonal JSON feed unavailable" }, { status: 404, headers });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400, headers });
  }

  const cycle = loadSeasonalCycleConfig();
  const aid = Number(body.aid);
  const expectedUpdatedAt = Number(body.expectedUpdatedAt);
  if (
    !cycle || cycle.collectionSource !== "json_feed" ||
    body.cycleId !== cycle.cycleId ||
    !Number.isSafeInteger(aid) || aid <= 0 ||
    !Number.isSafeInteger(expectedUpdatedAt) || expectedUpdatedAt <= 0
  ) {
    return Response.json({ error: "Invalid Seasonal capture" }, { status: 400, headers });
  }

  try {
    const result = await resolveSeasonalProfile(
      { aid, cycleId: cycle.cycleId, force: true, expectedUpdatedAt },
      {
        loadCycle: loadSeasonalCycleConfig,
        allowDisabledCycle: true,
        validatePayload: (payload, currentCycle) => validateSeasonalProfile(payload, {
          enabled: true,
          confirmedContract: currentCycle.upstreamContract,
          cycleId: currentCycle.cycleId,
          seasonStartsAt: currentCycle.startsAt,
          seasonEndsAt: currentCycle.endsAt,
        }),
        fetchPayload: ({ aid: profileAid, expectedUpdatedAt: version }) =>
          fetchSeasonalPayload(profileAid, { expectedUpdatedAt: version }),
        getStore: getSeasonalStore,
        afterCapture: async ({ cycle: currentCycle, profile, capture, observedAt }) => {
          await recordSeasonalCaptureLifecycle(currentCycle, profile, capture, "task", observedAt);
        },
      },
    );

    if (!result.ok) {
      return Response.json({ error: result.error }, { status: result.status, headers });
    }
    if (result.capture.inserted === true) {
      revalidateTag(SEASONAL_AVERAGE_CACHE_TAG, "max");
      await markAveragePublicationDirty(seasonalPublicationScope(cycle.cycleId));
    }
    return Response.json({
      state: result.capture.inserted ? "updated" : result.capture.status,
      profileUpdatedAt: result.profile.profileUpdatedAt,
      capture: result.capture,
    }, { headers });
  } catch (error) {
    console.error("seasonal JSON profile capture failed", error);
    return Response.json({ error: "Seasonal profile capture failed" }, { status: 503, headers });
  }
}
