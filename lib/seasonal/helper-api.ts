import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getClientIp } from "@/lib/client-ip";
import { getRateLimitHeaders } from "@/lib/rate-limiter";
import { validateSeasonalProfile } from "@/lib/seasonal-upstream";
import { isCommunityHelperEnabled, loadSeasonalCycleConfig } from "@/lib/seasonal/config";
import { HELPER_COOKIE, helperCookieOptions, parseHelperTaskId, signHelperSession, verifyHelperCompletion, verifyHelperSession } from "./helper-core";
import { getHelperStore } from "./helper-storage";
import { getSeasonalStore } from "./storage";
import { fetchSeasonalPayload } from "./fetch";
import { getPlayerLevels, getPublicProfile, parseProfileStats } from "@/lib/tarkov-api";
import { getStore } from "@/lib/db";
import { finalizeSeasonalTaskLifecycle, recordLinkedPvpLifecycle, recordSeasonalCaptureLifecycle } from "./scanner";
import { refreshProgressionAfterCapture } from "./daily-aggregates";

const noStore = { "Cache-Control": "no-store" };

export function helperError(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: noStore });
}

export async function helperContext(request: NextRequest, bucket: string, max: number) {
  if (!isCommunityHelperEnabled()) return { response: helperError("Helper unavailable", 404) } as const;
  if (!getRateLimitHeaders(getClientIp(request), { bucket, max }).allowed) {
    return { response: helperError("Rate limit exceeded", 429) } as const;
  }
  const helperId = await verifyHelperSession(request.cookies.get(HELPER_COOKIE)?.value);
  if (!helperId) return { response: helperError("Invalid helper session", 401) } as const;
  const store = await getHelperStore();
  const seasonal = await getSeasonalStore();
  const cycle = loadSeasonalCycleConfig();
  if (!store || !seasonal || !cycle) return { response: helperError("Helper unavailable", 503) } as const;
  return { helperId, store, seasonal, cycle } as const;
}

export async function issueHelperSession(request: NextRequest) {
  if (!isCommunityHelperEnabled()) return helperError("Helper unavailable", 404);
  if (!getRateLimitHeaders(getClientIp(request), { bucket: "seasonal-helper-session", max: 5 }).allowed) {
    return helperError("Rate limit exceeded", 429);
  }
  const store = await getHelperStore();
  if (!store) return helperError("Helper unavailable", 503);
  const helperId = randomUUID();
  const pollingUntil = await store.touchSession(helperId);
  const response = NextResponse.json({ pollingUntil }, { headers: noStore });
  response.cookies.set(HELPER_COOKIE, await signHelperSession(helperId), helperCookieOptions());
  return response;
}

export async function parseTaskId(request: NextRequest): Promise<number | null> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) return null;
  const body = await request.json().catch(() => null) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return parseHelperTaskId(body);
}

export async function verifyTask(request: NextRequest) {
  const context = await helperContext(request, "seasonal-helper-verify", 40);
  if ("response" in context) return context.response;
  const taskId = await parseTaskId(request);
  if (!taskId) return helperError("Invalid request", 400);
  const task = await context.store.getActiveLease(taskId, context.helperId, context.cycle.cycleId);
  if (!task) return helperError("Invalid lease", 409);

  // Branch only on the server-loaded lease. The browser cannot turn a
  // Seasonal task into a linked PvP task (or vice versa).
  if (task.kind === "linked_pvp") {
    try {
      const { profile } = await getPublicProfile(task.aid, { force: true });
      if (!profile) return helperError("PvP profile is not cached yet", 409);
      if (String((profile as { aid?: unknown }).aid) !== String(task.aid)) {
        return helperError("PvP profile account mismatch", 409);
      }
      const stats = parseProfileStats(profile, await getPlayerLevels());
      const publicStore = await getStore();
      if (publicStore) {
        await publicStore.upsert(task.aid, stats, profile.achievements ? Object.keys(profile.achievements) : []);
      }
      await recordLinkedPvpLifecycle(context.cycle, task.aid, stats.hoursPlayed);
      if (!await context.store.finish(task.id, context.helperId, "completed")) {
        return helperError("Invalid lease", 409);
      }
      await finalizeSeasonalTaskLifecycle(context.cycle, task.id).catch((error) =>
        console.error("Seasonal linked PvP follow-up failed", error));
      return NextResponse.json({ completed: true, kind: task.kind }, { headers: noStore });
    } catch {
      return helperError("PvP profile unavailable", 502);
    }
  }

  let payload: unknown;
  try {
    payload = await fetchSeasonalPayload(task.aid);
  } catch {
    return helperError("Profile unavailable", 502);
  }
  const validated = validateSeasonalProfile(payload, {
    enabled: context.cycle.enabled, cycleId: context.cycle.cycleId,
    seasonStartsAt: context.cycle.startsAt, seasonEndsAt: context.cycle.endsAt,
    confirmedContract: context.cycle.upstreamContract,
  });
  if (!validated.ok) return helperError("Invalid upstream profile", 409);
  const decision = verifyHelperCompletion({
    enabled: true, helperId: context.helperId,
    task: { ...task, mode: "seasonal" },
    profile: { ...validated.profile, mode: "seasonal" },
    cycleStartsAt: context.cycle.startsAt, cycleEndsAt: context.cycle.endsAt,
  });
  if (!decision.ok) return helperError(decision.reason, 409);
  await context.seasonal.upsertProfile(validated.profile);
  const capture = await context.seasonal.captureSnapshot(validated.profile);
  await recordSeasonalCaptureLifecycle(context.cycle, validated.profile, capture, "task");
  if (capture.inserted) {
    await refreshProgressionAfterCapture("seasonal", context.cycle.cycleId, validated.profile.counters.pmcRaids, { force: true });
  }
  if (!await context.store.finish(task.id, context.helperId, "completed")) return helperError("Invalid lease", 409);
  await finalizeSeasonalTaskLifecycle(context.cycle, task.id).catch((error) =>
    console.error("Seasonal profile follow-up failed", error));
  return NextResponse.json({ completed: true, capture: capture.status }, { headers: noStore });
}
