import { revalidateTag } from "next/cache";
import { isOperatorRequest, operatorNoStoreHeaders } from "@/lib/operator-auth";
import { resolveTrackedProfilePayload, snapshotFromOperatorProfile } from "@/lib/operator-profile";
import { persistRegularProfileSnapshot } from "@/lib/regular-profile-capture";
import { PublicProfileVersionConflictError, pveProfileDecision } from "@/lib/tarkov-api";
import { ARENA_PARSER_VERSION, persistArenaProfile } from "@/lib/arena/service";
import { ARENA_AVERAGE_CACHE_TAG } from "@/lib/average-cache";
import { getArenaBackend } from "@/lib/db";

export const runtime = "nodejs";

async function isCurrentArenaSyncRun(request: Request, body: unknown): Promise<boolean> {
  const runId = request.headers.get("x-profile-refresh-run-id");
  if (!runId || typeof body !== "object" || body === null || Array.isArray(body) ||
    (body as { mode?: unknown }).mode !== "arena") return true;
  const backend = await getArenaBackend();
  if (!backend || backend.kind !== "sqlite") return false;
  const table = backend.db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'arena_profile_sync_lease'"
  ).get();
  if (!table) return false;
  const lease = backend.db.prepare(
    "SELECT owner, heartbeat_at FROM arena_profile_sync_lease WHERE id = 1"
  ).get() as { owner?: unknown; heartbeat_at?: unknown } | undefined;
  const leaseMs = Number(process.env.ARENA_PROFILE_SYNC_LEASE_MS ?? 30 * 60_000);
  const age = Date.now() - Number(lease?.heartbeat_at);
  return lease?.owner === runId && Number.isFinite(age) && age >= 0 && age <= leaseMs;
}

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

  if (!(await isCurrentArenaSyncRun(request, body))) {
    return Response.json({ state: "stale" }, { status: 409, headers });
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
      if (!(await isCurrentArenaSyncRun(request, body))) {
        return Response.json({ state: "stale" }, { status: 409, headers });
      }
      const leaseOwner = request.headers.get("x-profile-refresh-run-id") ?? undefined;
      const arena = await persistArenaProfile(resolved.payload.profile, {
        leaseOwner,
        leaseMaxAgeMs: Number(process.env.ARENA_PROFILE_SYNC_LEASE_MS ?? 30 * 60_000),
      });
      revalidateTag(ARENA_AVERAGE_CACHE_TAG, "max");
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
