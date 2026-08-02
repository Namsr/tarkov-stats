import { unstable_cache } from "next/cache";
import {
  getLatestProgressionRevision,
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
  "public, max-age=60, s-maxage=60, stale-while-revalidate=30";

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
