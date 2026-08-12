import { isOperatorRequest, operatorNoStoreHeaders } from "@/lib/operator-auth";
import { validateSeasonalProfile } from "@/lib/seasonal-upstream";
import { isSeasonalRolloutReady, loadSeasonalCycleConfig } from "@/lib/seasonal/config";
import { getSeasonalStore } from "@/lib/seasonal/storage";
import { getSeasonalOperatorStore } from "@/lib/seasonal/operator";
import { getPlayerLevels, getPublicProfile, parseProfileStats } from "@/lib/tarkov-api";
import { getStore } from "@/lib/db";
import { recordLinkedPvpLifecycle, recordSeasonalCaptureLifecycle } from "@/lib/seasonal/scanner";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const headers = operatorNoStoreHeaders();
  if (!(await isOperatorRequest(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  }
  if (!isSeasonalRolloutReady()) {
    return Response.json({ error: "Seasonal capture unavailable" }, { status: 404, headers });
  }
  if (loadSeasonalCycleConfig()?.collectionSource === "json_feed") {
    return Response.json({ error: "Seasonal JSON feed owns collection" }, { status: 404, headers });
  }
  const body = await request.json().catch(() => null) as
    | { aid?: unknown; cycleId?: unknown; runId?: unknown; taskId?: unknown; owner?: unknown; profile?: unknown }
    | null;
  const cycle = loadSeasonalCycleConfig();
  if (!cycle || body?.cycleId !== cycle.cycleId || Number(body.aid) <= 0) {
    return Response.json({ error: "Invalid Seasonal capture" }, { status: 400, headers });
  }
  try {
    const operator = await getSeasonalOperatorStore();
    const lease = await operator.activeLease({
      runId: Number(body.runId), taskId: Number(body.taskId), owner: String(body.owner ?? ""),
    });
    if (!lease || lease.aid !== Number(body.aid) || lease.cycleId !== cycle.cycleId) {
      return Response.json({ error: "Active Seasonal lease not found" }, { status: 409, headers });
    }
    if (lease.kind === "linked_pvp") {
      const { profile } = await getPublicProfile(lease.aid, { force: true });
      if (!profile) return Response.json({ error: "PvP profile is not cached yet" }, { status: 409, headers });
      if (String((profile as { aid?: unknown }).aid) !== String(lease.aid)) {
        return Response.json({ error: "PvP profile account mismatch" }, { status: 409, headers });
      }
      const stats = parseProfileStats(profile, await getPlayerLevels());
      const publicStore = await getStore();
      if (publicStore) {
        await publicStore.upsert(lease.aid, stats, profile.achievements ? Object.keys(profile.achievements) : []);
      }
      await recordLinkedPvpLifecycle(cycle, lease.aid, {
        hours: stats.hoursPlayed,
        achievementIds: profile.achievements ? Object.keys(profile.achievements) : [],
        profileUpdatedAt: stats.profileUpdatedAt ?? null,
      });
      return Response.json({ state: "linked_pvp" }, { headers });
    }
    const validated = validateSeasonalProfile(body.profile, {
      enabled: cycle.enabled,
      confirmedContract: cycle.upstreamContract,
      cycleId: cycle.cycleId,
      seasonStartsAt: cycle.startsAt,
      seasonEndsAt: cycle.endsAt,
    });
    if (!validated.ok || validated.profile.aid !== Number(body.aid)) {
      return Response.json({ error: "Invalid Seasonal profile" }, { status: 409, headers });
    }
    const store = await getSeasonalStore();
    if (!store) throw new Error("Seasonal storage unavailable");
    await store.upsertProfile(validated.profile);
    const capture = await store.captureSnapshot(validated.profile);
    await recordSeasonalCaptureLifecycle(cycle, validated.profile, capture, "task");
    return Response.json({ state: capture.status }, { headers });
  } catch (error) {
    console.error("operator Seasonal capture failed", error);
    return Response.json({ error: "Seasonal capture failed" }, { status: 503, headers });
  }
}
