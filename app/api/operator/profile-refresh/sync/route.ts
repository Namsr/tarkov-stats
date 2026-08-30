import { revalidateTag } from "next/cache";
import { after } from "next/server";
import { isOperatorRequest, operatorNoStoreHeaders } from "@/lib/operator-auth";
import { resolveTrackedProfilePayload, snapshotFromOperatorProfile } from "@/lib/operator-profile";
import { persistRegularProfileSnapshot } from "@/lib/regular-profile-capture";
import { PublicProfileVersionConflictError, pveProfileDecision } from "@/lib/tarkov-api";
import { ARENA_PARSER_VERSION, persistArenaProfile } from "@/lib/arena/service";
import { ARENA_AVERAGE_CACHE_TAG } from "@/lib/average-cache";
import { warmAverageCaches } from "@/lib/average-warmer";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const headers = operatorNoStoreHeaders();
  if (!(await isOperatorRequest(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400, headers });
  }

  try {
    const resolved = await resolveTrackedProfilePayload(body);
    if (resolved.state === "invalid") {
      return Response.json({ error: "Invalid sync payload" }, { status: 400, headers });
    }
    if (resolved.state === "not_found") {
      return Response.json({ state: "not_found" }, { status: 404, headers });
    }

    if (resolved.payload.mode === "arena") {
      const arena = await persistArenaProfile(resolved.payload.profile);
      revalidateTag(ARENA_AVERAGE_CACHE_TAG, "max");
      after(() => warmAverageCaches(new URL(request.url).origin));
      return Response.json({
        state: "updated",
        profileUpdatedAt: arena.profileUpdatedAt,
        schemaVersion: ARENA_PARSER_VERSION,
      }, { headers });
    }
    const snapshot = await snapshotFromOperatorProfile(resolved.payload, { upsertPlayer: false });
    if (resolved.payload.mode === "pve") {
      const decision = pveProfileDecision(resolved.payload.profile);
      if (decision.state !== "store") {
        return Response.json({
          state: decision.state,
          profileUpdatedAt: snapshot.upstreamUpdatedAt,
          lastSkillAccess: decision.lastSkillAccess,
        }, { headers });
      }
    }
    const result = await persistRegularProfileSnapshot(snapshot, {
      mode: resolved.payload.mode === "pve" ? "pve" : "regular",
      strict: true,
    });
    return Response.json({
      state: result!.inserted ? "updated" : result!.status,
      profileUpdatedAt: snapshot.upstreamUpdatedAt,
    }, { headers });
  } catch (error) {
    if (error instanceof PublicProfileVersionConflictError) {
      return Response.json({ state: "stale", actualUpdatedAt: error.actualUpdatedAt }, { status: 409, headers });
    }
    console.error("tracked profile sync failed", error);
    return Response.json({ error: "Tracked profile sync failed" }, { status: 503, headers });
  }
}
