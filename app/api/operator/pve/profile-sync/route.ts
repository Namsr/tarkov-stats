import { makePlayerSnapshot } from "@/lib/ban-db";
import { isOperatorRequest, operatorNoStoreHeaders } from "@/lib/operator-auth";
import { persistRegularProfileSnapshot } from "@/lib/regular-profile-capture";
import {
  getPublicProfile,
  parseProfileStats,
  PLAYER_LEVELS_V2026_07_22,
  PublicProfileVersionConflictError,
  pveProfileDecision,
} from "@/lib/tarkov-api";

export const runtime = "nodejs";

function validPayload(value: unknown): { aid: number; expectedUpdatedAt: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { aid, expectedUpdatedAt } = value as Record<string, unknown>;
  const parsedAid = Number(aid);
  const parsedUpdatedAt = Number(expectedUpdatedAt);
  if (!Number.isSafeInteger(parsedAid) || parsedAid <= 0 ||
      !Number.isSafeInteger(parsedUpdatedAt) || parsedUpdatedAt <= 0) return null;
  return { aid: parsedAid, expectedUpdatedAt: parsedUpdatedAt };
}

/** Narrow authenticated write boundary for `pve/updated.json` collection. */
export async function POST(request: Request) {
  const headers = operatorNoStoreHeaders();
  if (!(await isOperatorRequest(request))) {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  }

  let input: { aid: number; expectedUpdatedAt: number } | null;
  try {
    input = validPayload(await request.json());
  } catch {
    input = null;
  }
  if (!input) return Response.json({ error: "Invalid PvE capture" }, { status: 400, headers });

  try {
    const { profile } = await getPublicProfile(input.aid, {
      force: true,
      mode: "pve",
      expectedUpdatedAt: input.expectedUpdatedAt,
    });
    if (!profile) return Response.json({ state: "not_found" }, { status: 404, headers });

    const profileUpdatedAt = Number(profile.updated);
    const decision = pveProfileDecision(profile);
    if (decision.state !== "store") {
      return Response.json({
        state: decision.state,
        profileUpdatedAt,
        lastSkillAccess: decision.lastSkillAccess,
      }, { headers });
    }

    const stats = parseProfileStats(profile, [...PLAYER_LEVELS_V2026_07_22]);
    stats.profileUpdatedAt = profileUpdatedAt;
    const achievementIds = profile.achievements ? Object.keys(profile.achievements) : [];
    const snapshot = makePlayerSnapshot(input.aid, stats, achievementIds, profileUpdatedAt);
    const capture = await persistRegularProfileSnapshot(snapshot, { mode: "pve", strict: true });
    return Response.json({
      state: capture?.inserted ? "updated" : capture?.status,
      profileUpdatedAt: snapshot.upstreamUpdatedAt,
      capture,
    }, { headers });
  } catch (error) {
    if (error instanceof PublicProfileVersionConflictError) {
      return Response.json({ state: "stale", actualUpdatedAt: error.actualUpdatedAt }, { status: 409, headers });
    }
    console.error("PvE JSON profile capture failed", error);
    return Response.json({ error: "PvE profile capture failed" }, { status: 503, headers });
  }
}
