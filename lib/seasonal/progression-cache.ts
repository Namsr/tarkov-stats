import { unstable_cache } from "next/cache";
import {
  getProgressionBundleQuery,
  type ProgressionBundle,
} from "@/lib/seasonal/progression-db";
import {
  progressionFlightKey,
  singleFlight,
} from "@/lib/seasonal/progression-flight";
import type { ProgressionMode } from "@/types/seasonal";

export const PROGRESSION_CACHE_TTL_SECONDS = 18_000;
export const PROGRESSION_CACHE_CONTROL =
  "public, max-age=60, s-maxage=18000, stale-while-revalidate=300";

export type CachedProgressionBundle =
  | { status: "ready"; bundle: ProgressionBundle }
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
  ): Promise<CachedProgressionBundle> => {
    const query = await getProgressionBundleQuery();
    if (!query) throw new UncacheableProgressionResult("unavailable");
    const bundle = await query({ mode, cycleId, aid });
    if (!bundle) throw new UncacheableProgressionResult("not-found");
    return { status: "ready", bundle };
  },
  ["progression-bundle-v2"],
  { revalidate: PROGRESSION_CACHE_TTL_SECONDS },
);

const inFlightProgressionBundles = new Map<string, Promise<CachedProgressionBundle>>();

export function getCachedProgressionBundle(
  mode: ProgressionMode,
  cycleId: string,
  aid: number,
): Promise<CachedProgressionBundle> {
  return singleFlight(
    inFlightProgressionBundles,
    progressionFlightKey(mode, cycleId, aid),
    () => loadProgressionBundle(mode, cycleId, aid).catch((error: unknown) => {
      if (error instanceof UncacheableProgressionResult) {
        return { status: error.status };
      }
      throw error;
    }),
  );
}
