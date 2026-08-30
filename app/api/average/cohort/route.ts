import { NextRequest, NextResponse } from "next/server";
import {
  getStore,
  parseAveragePeriod,
  parseAverageStatistic,
  type RadarMetric,
  type RangeDimension,
} from "@/lib/db";
import { isGameMode } from "@/types/seasonal";
import { createRequestTiming } from "@/lib/observability/request-timing";
import { getPublicProfile, parseProfileStats } from "@/lib/tarkov-api";
import { ARENA_PARSER_VERSION, getArenaCohort } from "@/lib/arena/service";
import { ARENA_MODE_KEYS, type ArenaStoredMode } from "@/types/arena";
import { getProgressionStore } from "@/lib/progression-db";
import { loadDynamicAverage } from "@/lib/average-dynamic-cache";

const RADAR_METRICS: RadarMetric[] = [
  "kd_ratio",
  "pmc_kd_ratio",
  "kills_per_raid",
  "pmc_survival_rate",
  "longest_win_streak",
  "level",
];

function emptyAverages() {
  return Object.fromEntries(
    RADAR_METRICS.map((metric) => [metric, { value: null, count: 0 }])
  );
}

function parseDimension(value: string | null): RangeDimension | null {
  if (value == null || value === "hours") return "hours";
  if (value === "pmc_raids") return "pmc_raids";
  return null;
}

function boundsAtThirtyPercent(dimension: RangeDimension, center: number) {
  if (dimension === "hours") {
    return {
      min: Math.max(0, Math.floor(center * 0.7 * 10) / 10),
      max: Math.ceil(center * 1.3 * 10) / 10,
    };
  }
  return { min: Math.max(0, Math.floor(center * 0.7)), max: Math.ceil(center * 1.3) };
}

function isArenaMode(value: string | null): value is ArenaStoredMode {
  return value === "overall" || (value !== null && (ARENA_MODE_KEYS as readonly string[]).includes(value));
}

async function arenaCohortResponse(
  request: NextRequest,
  timing: ReturnType<typeof createRequestTiming>,
) {
  const params = request.nextUrl.searchParams;
  const requestedAid = params.get("aid");
  const aid = Number(requestedAid);
  const arenaMode = params.get("arenaMode");
  const statistic = parseAverageStatistic(params.get("statistic"));
  const period = params.get("period");
  if (
    !requestedAid || !Number.isSafeInteger(aid) || aid <= 0 ||
    !isArenaMode(arenaMode) ||
    (statistic !== "trimmed_mean" && statistic !== "median") ||
    (period !== null && period !== "all") ||
    params.has("center") || params.has("excludeAid") || params.has("dimension")
  ) {
    timing.finish({ operation: "average_cohort", mode: "arena", outcome: "invalid", status: 400 });
    return NextResponse.json({ error: "Invalid Arena cohort query" }, { status: 400 });
  }
  try {
    const cohort = await getArenaCohort(aid, arenaMode, statistic);
    if (!cohort) {
      timing.finish({ operation: "average_cohort", mode: "arena", outcome: "unavailable", status: 503 });
      return NextResponse.json({
        identity: { aid, mode: "arena", cycleId: "persistent" },
        code: "comparison_unavailable",
        error: "Arena comparison storage is unavailable",
      }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    timing.finish({ operation: "average_cohort", mode: "arena", outcome: "success", status: 200, storage: "sqlite" });
    return NextResponse.json({ gameMode: "arena", schemaVersion: ARENA_PARSER_VERSION, ...cohort }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("Arena comparison cohort failed", error);
    timing.finish({ operation: "average_cohort", mode: "arena", outcome: "error", status: 503 });
    return NextResponse.json({
      identity: { aid, mode: "arena", cycleId: "persistent" },
      code: "comparison_unavailable",
      error: "Failed to compute Arena comparison cohort",
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

export async function GET(request: NextRequest) {
  const timing = createRequestTiming();
  timing.setRequestContext({ host: request.headers.get("x-forwarded-host") ?? request.headers.get("host") });
  const params = request.nextUrl.searchParams;
  const rawMode = params.get("mode") ?? "regular";
  if (rawMode === "arena") return arenaCohortResponse(request, timing);
  if (!isGameMode(rawMode)) {
    timing.finish({ operation: "average_cohort", outcome: "invalid", status: 400 });
    return NextResponse.json({ error: "Invalid game mode" }, { status: 400 });
  }
  const statistic = parseAverageStatistic(params.get("statistic"));
  if (!statistic) {
    timing.finish({ operation: "average_cohort", mode: rawMode, outcome: "invalid", status: 400 });
    return NextResponse.json({ error: "Invalid statistic" }, { status: 400 });
  }
  const period = parseAveragePeriod(params.get("period"));
  if (!period || (rawMode !== "regular" && rawMode !== "pve" && period !== "all")) {
    timing.finish({ operation: "average_cohort", mode: rawMode, outcome: "invalid", status: 400 });
    return NextResponse.json({ error: "Invalid period" }, { status: 400 });
  }
  if (rawMode === "seasonal") {
    timing.finish({ operation: "average_cohort", mode: rawMode, outcome: "invalid", status: 400 });
    return NextResponse.json(
      { error: "Seasonal comparison uses /api/seasonal/cohort" },
      { status: 400 },
    );
  }

  if (rawMode === "regular" || rawMode === "pve") {
    const mode = rawMode;
    const requestedAid = params.get("aid");
    const aid = Number(requestedAid);
    if (!requestedAid || !Number.isSafeInteger(aid) || aid <= 0) {
      timing.finish({ operation: "average_cohort", mode: rawMode, outcome: "invalid", status: 400 });
      return NextResponse.json(
        { error: "aid is required and must be a positive integer" },
        { status: 400 },
      );
    }
    timing.setRequestContext({ aid });
    let source: "stored" | "upstream" | undefined;
    let cache: "hit" | "miss" | undefined;
    let profileMs: number | undefined;
    let storeOpenMs: number | undefined;
    let storeReadMs: number | undefined;
    let cohortMs: number | undefined;
    try {
      const storeOpenStarted = timing.now();
      const [progressionStore, store] = await Promise.all([getProgressionStore(mode), getStore(mode)]);
      storeOpenMs = timing.elapsedMs(storeOpenStarted);
      if (!store) {
        timing.finish({
          operation: "average_cohort", mode, outcome: "unavailable", status: 503,
          storage: "unavailable", storeOpenMs,
        });
        return NextResponse.json({
          identity: { aid, mode, cycleId: "persistent" },
          code: "comparison_unavailable",
          error: "Comparison storage is unavailable",
        }, { status: 503, headers: { "Cache-Control": "no-store" } });
      }

      const storeReadStarted = timing.now();
      const snapshot = progressionStore ? await progressionStore.latest(aid).catch(() => null) : null;
      storeReadMs = timing.elapsedMs(storeReadStarted);
      let stats = snapshot?.stats;
      if (stats) {
        source = "stored";
      } else {
        source = "upstream";
        const profileStarted = timing.now();
        const profileResult = await getPublicProfile(aid, { mode });
        profileMs = timing.elapsedMs(profileStarted);
        if (!profileResult.profile) {
          timing.finish({
            operation: "average_cohort", mode, outcome: "not_found", status: 404,
            source, storage: "sqlite", profileMs, storeOpenMs, storeReadMs,
          });
          return NextResponse.json({
            identity: { aid, mode, cycleId: "persistent" },
            code: "profile_unavailable",
            error: "Profile is not available for comparison",
          }, { status: 404, headers: { "Cache-Control": "no-store" } });
        }
        stats = parseProfileStats(profileResult.profile, []);
      }

      const centerHours = Number(stats.hoursPlayed);
      const centerPmcRaids = Number(stats.pmcRaids);
      const version = snapshot?.upstreamUpdatedAt ?? (Number(stats.profileUpdatedAt) || 0);
      const cohortStarted = timing.now();
      const loaded = await loadDynamicAverage(
        ["cohort", "persistent", mode, aid, version, centerHours, centerPmcRaids, statistic, period].join(":"),
        () => store.cohort2d(centerHours, centerPmcRaids, aid, "hours", statistic, period),
      );
      cohortMs = timing.elapsedMs(cohortStarted);
      cache = loaded.cache;
      timing.finish({
        operation: "average_cohort", mode, outcome: "success", status: 200,
        source, cache, storage: "sqlite", profileMs, storeOpenMs, storeReadMs, cohortMs,
      });
      return NextResponse.json({ ...loaded.value, statistic, period }, {
        headers: { "Cache-Control": "private, no-store" },
      });
    } catch (error) {
      console.error("persistent comparison cohort failed", error);
      timing.finish({
        operation: "average_cohort", mode: rawMode, outcome: "error", status: 503,
        source, cache, storage: "sqlite", profileMs, storeOpenMs, storeReadMs, cohortMs,
      });
      return NextResponse.json({
        identity: { aid, mode, cycleId: "persistent" },
        code: "comparison_unavailable",
        error: "Failed to compute comparison cohort",
      }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
  }

  const dimension = parseDimension(params.get("dimension"));
  const centerValue = params.get("center");
  const center = Number(centerValue);
  const excludeAid = Number(params.get("excludeAid"));
  if (!dimension) {
    timing.finish({ operation: "average_cohort", mode: rawMode, outcome: "invalid", status: 400 });
    return NextResponse.json({ error: "Invalid dimension" }, { status: 400 });
  }
  if (centerValue == null || centerValue === "" || !Number.isFinite(center) || center < 0) {
    timing.finish({ operation: "average_cohort", mode: rawMode, outcome: "invalid", status: 400 });
    return NextResponse.json({ error: "Center must be finite and non-negative" }, { status: 400 });
  }
  if (
    !params.has("excludeAid") ||
    !Number.isSafeInteger(excludeAid) ||
    excludeAid <= 0
  ) {
    timing.finish({ operation: "average_cohort", mode: rawMode, outcome: "invalid", status: 400 });
    return NextResponse.json({ error: "excludeAid must be a positive integer" }, { status: 400 });
  }

  const storeOpenStarted = timing.now();
  const store = await getStore(rawMode).catch((error) => {
    timing.finish({
      operation: "average_cohort", mode: rawMode, outcome: "error", status: 500,
      storage: "unavailable", storeOpenMs: timing.elapsedMs(storeOpenStarted),
    });
    throw error;
  });
  const storeOpenMs = timing.elapsedMs(storeOpenStarted);
  if (!store) {
    const noActivity = center === 0;
    const response = NextResponse.json({
      dimension,
      center,
      target: 20,
      percent: noActivity ? 10 : 30,
      bounds: noActivity ? { min: 0, max: 0 } : boundsAtThirtyPercent(dimension, center),
      n: 0,
      quality: "unavailable",
      reason: noActivity ? "no_activity" : "above_coverage",
      averages: emptyAverages(),
      statistic,
      period,
    });
    timing.finish({
      operation: "average_cohort", mode: rawMode, outcome: "unavailable", status: 200,
      storage: "unavailable", storeOpenMs,
    });
    return response;
  }

  let cohortMs: number | undefined;
  try {
    const cohortStarted = timing.now();
    const cohort = await store.cohort(
      dimension,
      center,
      excludeAid,
      statistic,
      period,
    ).finally(() => {
      cohortMs = timing.elapsedMs(cohortStarted);
    });
    const response = NextResponse.json({ ...cohort, statistic, period }, {
      headers: { "Cache-Control": "public, max-age=60" },
    });
    timing.finish({
      operation: "average_cohort", mode: rawMode, outcome: "success", status: 200,
      storage: "sqlite", storeOpenMs, cohortMs,
    });
    return response;
  } catch (error) {
    console.error("average cohort failed", error);
    timing.finish({
      operation: "average_cohort", mode: rawMode, outcome: "error", status: 500,
      storage: "sqlite", storeOpenMs, cohortMs,
    });
    return NextResponse.json({ error: "Failed to compute comparison cohort" }, { status: 500 });
  }
}
