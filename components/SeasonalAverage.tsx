"use client";

import AveragePage from "@/app/average/page";
import type { LevelBand } from "@/lib/seasonal/ui";

/**
 * Compatibility export for old imports. Seasonal now deliberately renders the
 * same dashboard as PvP; there is no separate freshness/portrait branch.
 * The shared settings still use the average-settings__top /
 * average-settings__mode md:col-start-2 layout.
 */
export default function SeasonalAverage({ cycleId, levelBands }: { cycleId: string; levelBands: LevelBand[] }) {
  return <AveragePage mode="seasonal" cycleId={cycleId} levelBands={levelBands} />;
}
