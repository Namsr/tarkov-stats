import { connection } from "next/server";
import LegacyAveragePage from "@/app/average/page";
import ModeUnavailable from "@/components/ModeUnavailable";
import { isSeasonalRolloutReady, loadSeasonalCycleConfig } from "@/lib/seasonal/config";
import { cumulativeLevelBands } from "@/lib/seasonal/ui";
import { PLAYER_LEVELS_V2026_07_22 } from "@/lib/tarkov-api";
import { isGameMode, SEASONAL_UPSTREAM_MODE, SEASON_ROUTE_MODE } from "@/types/seasonal";

interface Props {
  params: Promise<{ mode: string }>;
  searchParams: Promise<{ cycle?: string | string[] }>;
}

export default async function CanonicalAveragePage({ params, searchParams }: Props) {
  await connection();
  const { mode: routeMode } = await params;
  const mode = routeMode === SEASON_ROUTE_MODE || routeMode === SEASONAL_UPSTREAM_MODE
    ? "seasonal"
    : routeMode;
  if (!isGameMode(mode)) return <ModeUnavailable />;
  // Level bands are presentation metadata for the below-the-fold progression
  // chart. Do not block the mode switch on the remote reference fetch: the
  // chart can render from the known-good local snapshot while the average
  // profile request starts immediately.
  const levelBands = cumulativeLevelBands(PLAYER_LEVELS_V2026_07_22);
  if (mode === "regular") {
    return <LegacyAveragePage mode={mode} levelBands={levelBands} />;
  }
  if (mode !== "seasonal") return <LegacyAveragePage mode={mode} />;
  const cycle = loadSeasonalCycleConfig();
  const requestedCycle = (await searchParams).cycle;
  if (!isSeasonalRolloutReady() || !cycle || Array.isArray(requestedCycle) || (requestedCycle && requestedCycle !== cycle.cycleId)) {
    return <ModeUnavailable seasonal />;
  }
  return <LegacyAveragePage mode="seasonal" cycleId={cycle.cycleId} levelBands={levelBands} />;
}
