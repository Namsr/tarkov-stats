import { unstable_cache } from "next/cache";
import {
  getLatestProgressionRevision,
  getProgressionTimelineRevisions,
  getProgressionBundleQuery,
  getProgressionTimelineQuery,
  type ProgressionBundle,
} from "@/lib/seasonal/progression-db";
import {
  progressionFlightKey,
  singleFlight,
} from "@/lib/seasonal/progression-flight";
import type { ProgressionMode, ProgressionTimelineResponse } from "@/types/seasonal";

export const PROGRESSION_CACHE_TTL_SECONDS = 18_000;
export const PROGRESSION_CACHE_CONTROL =
  "public, max-age=60, s-maxage=60, stale-while-revalidate=30";

export type CachedProgressionBundle =
  | { status: "ready"; bundle: ProgressionBundle }
  | { status: "not-found" }
  | { status: "unavailable" };

export type CachedProgressionTimeline =
  | { status: "ready"; timeline: ProgressionTimelineResponse }
  | { status: "not-found" }
  | { status: "unavailable" };

class UncacheableProgressionResult extends Error {
  constructor(readonly status: "not-found" | "unavailable") {
    super(status);
  }
}

const loadProgressionBundle = unstable_cache(
  async (
    mode: ProgressionMode,
    cycleId: string,
    aid: number,
    _revision: number | null,
  ): Promise<CachedProgressionBundle> => {
    void _revision;
    const query = await getProgressionBundleQuery();
    if (!query) throw new UncacheableProgressionResult("unavailable");
    const bundle = await query({ mode, cycleId, aid });
    if (!bundle) throw new UncacheableProgressionResult("not-found");
    return { status: "ready", bundle };
  },
  ["progression-bundle-v4"],
  { revalidate: PROGRESSION_CACHE_TTL_SECONDS },
);

const inFlightProgressionBundles = new Map<string, Promise<CachedProgressionBundle>>();

const loadProgressionTimeline = unstable_cache(
  async (
    mode: ProgressionMode,
    cycleId: string,
    aid: number,
    _personalRevision: number,
    _populationGeneration: number,
  ): Promise<CachedProgressionTimeline> => {
    void _personalRevision;
    void _populationGeneration;
    const query = await getProgressionTimelineQuery();
    if (!query) throw new UncacheableProgressionResult("unavailable");
    const timeline = await query({ mode, cycleId, aid });
    if (!timeline) throw new UncacheableProgressionResult("not-found");
    return { status: "ready", timeline };
  },
  ["progression-timeline-v2"],
  { revalidate: PROGRESSION_CACHE_TTL_SECONDS },
);

const inFlightProgressionTimelines = new Map<string, Promise<CachedProgressionTimeline>>();

export async function getCachedProgressionBundle(
  mode: ProgressionMode,
  cycleId: string,
  aid: number,
): Promise<CachedProgressionBundle> {
  const revision = await getLatestProgressionRevision({ mode, cycleId, aid });
  return singleFlight(
    inFlightProgressionBundles,
    `${progressionFlightKey(mode, cycleId, aid)}\0${revision ?? "none"}`,
    () => loadProgressionBundle(mode, cycleId, aid, revision).catch((error: unknown) => {
      if (error instanceof UncacheableProgressionResult) {
        return { status: error.status };
      }
      throw error;
    }),
  );
}

export async function getCachedProgressionTimeline(
  mode: ProgressionMode,
  cycleId: string,
  aid: number,
): Promise<CachedProgressionTimeline> {
  const { personalRevision, populationGeneration } = await getProgressionTimelineRevisions({ mode, cycleId, aid });
  return singleFlight(
    inFlightProgressionTimelines,
    `${progressionFlightKey(mode, cycleId, aid)}\0timeline\0${personalRevision}\0${populationGeneration}`,
    () => loadProgressionTimeline(mode, cycleId, aid, personalRevision, populationGeneration).catch((error: unknown) => {
      if (error instanceof UncacheableProgressionResult) {
        return { status: error.status };
      }
      throw error;
    }),
  );
}
