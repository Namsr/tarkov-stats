import { NextRequest, NextResponse } from "next/server";
import { parseAverageStatistic } from "@/lib/db";
import { createRequestTiming } from "@/lib/observability/request-timing";
import { ARENA_PARSER_VERSION, getArenaAverage, getArenaCohort } from "@/lib/arena/service";
import {
  ARENA_MODE_KEYS,
  type ArenaCohortResult,
  type ArenaModeKey,
  type ArenaStatistic,
} from "@/types/arena";
import {
  readAverageMatches,
  shouldFallbackToPopulation,
  toArenaPopulationCohort,
} from "@/components/arena-ui";
import { loadDynamicAverage } from "@/lib/average-dynamic-cache";
import { readAveragePublication, standardArenaVariant } from "@/lib/average-publication";

export type ArenaModeBaselinesPurpose = "matches" | "comparison";

function isPurpose(value: string | null): value is ArenaModeBaselinesPurpose {
  return value === "matches" || value === "comparison";
}

function parseModes(value: string | null): ArenaModeKey[] | null {
  if (value == null) return [...ARENA_MODE_KEYS];
  const modes = value.split(",").map((mode) => mode.trim()).filter((mode) => mode !== "");
  if (modes.length === 0) return null;
  const seen = new Set<string>();
  const parsed: ArenaModeKey[] = [];
  for (const mode of modes) {
    if (!(ARENA_MODE_KEYS as readonly string[]).includes(mode) || seen.has(mode)) return null;
    seen.add(mode);
    parsed.push(mode as ArenaModeKey);
  }
  return parsed;
}

/**
 * Population cohort for one mode. Prefers the pre-materialized publication
 * (the same payload `publicationOnly=1` serves) and computes the average
 * live when publications are disabled, still warming, or predate
 * averageMatches, so mode bars keep their markers instead of silently
 * falling back to the legacy max-scale.
 */
async function populationCohort(
  aid: number,
  mode: ArenaModeKey,
  statistic: ArenaStatistic,
  needsMatches: boolean,
): Promise<ArenaCohortResult | null> {
  const publication = await readAveragePublication<Record<string, unknown>>(
    "arena",
    standardArenaVariant(mode, statistic),
  );
  if (publication) {
    const cohort = toArenaPopulationCohort(
      { mode: "arena", schemaVersion: ARENA_PARSER_VERSION, ...publication.payload },
      aid,
      mode,
      statistic,
      ARENA_PARSER_VERSION,
    );
    const matches = readAverageMatches(cohort);
    const hasRequiredMatches = matches != null && matches.value !== null && matches.count >= 20;
    if (cohort && !shouldFallbackToPopulation(cohort) && (!needsMatches || hasRequiredMatches)) return cohort;
  }
  // Same LRU key shape as GET /api/average, so batch and single requests share entries.
  const dynamicKey = JSON.stringify(["arena", mode, statistic, "matches", "players", null, null, null, null]);
  const loaded = await loadDynamicAverage(dynamicKey, () =>
    getArenaAverage({ mode, statistic, dimension: "matches", metric: "players" }));
  if (!loaded.value) return null;
  return toArenaPopulationCohort(
    { mode: "arena", schemaVersion: ARENA_PARSER_VERSION, ...loaded.value },
    aid,
    mode,
    statistic,
    ARENA_PARSER_VERSION,
  );
}

async function comparisonCohort(
  aid: number,
  mode: ArenaModeKey,
  statistic: ArenaStatistic,
  needsMatches: boolean,
): Promise<ArenaCohortResult | null> {
  // Same LRU key as GET /api/average/cohort, so batch and single requests share entries.
  const loaded = await loadDynamicAverage(
    ["cohort", "arena", aid, mode, statistic].join(":"),
    () => getArenaCohort(aid, mode, statistic),
  );
  const cohort = loaded.value;
  if (!cohort) return null;
  if (!shouldFallbackToPopulation(cohort)) return cohort;
  return (await populationCohort(aid, mode, statistic, needsMatches)) ?? cohort;
}

async function batchResponse(request: NextRequest, timing: ReturnType<typeof createRequestTiming>) {
  const params = request.nextUrl.searchParams;
  const requestedAid = params.get("aid");
  const aid = Number(requestedAid);
  const statistic = parseAverageStatistic(params.get("statistic"));
  const purposeParam = params.get("purpose");
  const purpose: ArenaModeBaselinesPurpose = purposeParam == null ? "comparison" : purposeParam as ArenaModeBaselinesPurpose;
  const modes = parseModes(params.get("arenaModes"));
  if (
    !requestedAid || !Number.isSafeInteger(aid) || aid <= 0 ||
    (statistic !== "trimmed_mean" && statistic !== "median") ||
    !isPurpose(purpose) ||
    !modes
  ) {
    timing.finish({ operation: "average_cohort", mode: "arena", outcome: "invalid", status: 400 });
    return NextResponse.json({ error: "Invalid Arena baselines query" }, { status: 400 });
  }
  timing.setRequestContext({ aid });
  const selectedPurpose: ArenaModeBaselinesPurpose = purpose;
  let cohortMs: number | undefined;
  try {
    const batchStarted = timing.now();
    const entries = await Promise.all(modes.map(async (mode) => {
      try {
        const cohort = await comparisonCohort(
          aid,
          mode,
          statistic,
          selectedPurpose === "matches",
        );
        return [mode, cohort] as const;
      } catch {
        return [mode, null] as const;
      }
    })).finally(() => {
      cohortMs = timing.elapsedMs(batchStarted);
    });
    const cohorts = Object.fromEntries(entries) as Record<ArenaModeKey, ArenaCohortResult | null>;
    if (entries.every(([, cohort]) => cohort == null)) {
      timing.finish({ operation: "average_cohort", mode: "arena", outcome: "unavailable", status: 503, cohortMs });
      return NextResponse.json({
        identity: { aid, mode: "arena", cycleId: "persistent" },
        code: "comparison_unavailable",
        error: "Arena comparison storage is unavailable",
      }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    const unavailable = entries.filter(([, cohort]) => cohort == null).map(([mode]) => mode);
    timing.finish({ operation: "average_cohort", mode: "arena", outcome: "success", status: 200, cohortMs });
    // Per-aid data, same 60s envelope as the single-cohort route.
    return NextResponse.json({
      gameMode: "arena",
      schemaVersion: ARENA_PARSER_VERSION,
      aid,
      statistic,
      purpose: selectedPurpose,
      cohorts,
      unavailable,
    }, {
      headers: { "Cache-Control": "private, max-age=60" },
    });
  } catch (error) {
    console.error("Arena baselines batch failed", error);
    timing.finish({ operation: "average_cohort", mode: "arena", outcome: "error", status: 503, cohortMs });
    return NextResponse.json({
      identity: { aid, mode: "arena", cycleId: "persistent" },
      code: "comparison_unavailable",
      error: "Failed to compute Arena mode baselines",
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

export async function GET(request: NextRequest) {
  const timing = createRequestTiming();
  timing.setRequestContext({ host: request.headers.get("x-forwarded-host") ?? request.headers.get("host") });
  const rawMode = request.nextUrl.searchParams.get("mode") ?? "regular";
  if (rawMode !== "arena") {
    timing.finish({ operation: "average_cohort", outcome: "invalid", status: 400 });
    return NextResponse.json({ error: "Invalid game mode" }, { status: 400 });
  }
  return batchResponse(request, timing);
}
