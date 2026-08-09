import { connection } from "next/server";
import RegularPlayer from "@/components/RegularPlayer";
import ModeUnavailable from "@/components/ModeUnavailable";
import SeasonalPlayer from "@/components/SeasonalPlayer";
import { isSeasonalRolloutReady, loadSeasonalCycleConfig } from "@/lib/seasonal/config";
import { cumulativeLevelBands } from "@/lib/seasonal/ui";
import { getPlayerLevels } from "@/lib/tarkov-api";
import { parsePlayerId } from "@/lib/player-id";
import { isGameMode, SEASONAL_UPSTREAM_MODE, SEASON_ROUTE_MODE } from "@/types/seasonal";

interface Props {
  params: Promise<{ segments?: string[] }>;
  searchParams: Promise<{ cycle?: string | string[]; radarDemo?: string | string[] }>;
}

export default async function CanonicalPlayerPage({ params, searchParams }: Props) {
  await connection();
  const route = await params;
  const query = await searchParams;
  const segments = route.segments ?? [];
  const routeMode = segments.length === 1 ? "regular" : segments[0];
  const mode = routeMode === SEASON_ROUTE_MODE || routeMode === SEASONAL_UPSTREAM_MODE
    ? "seasonal"
    : routeMode;
  const aid = segments.length === 1 ? segments[0] : segments[1];
  if (segments.length < 1 || segments.length > 2 || !aid || !isGameMode(mode)) {
    return <ModeUnavailable />;
  }
  if (mode !== "seasonal") {
    return (
      <RegularPlayer
        mode={mode}
        params={Promise.resolve({ aid })}
        searchParams={Promise.resolve({ radarDemo: query.radarDemo })}
      />
    );
  }
  const parsedAid = parsePlayerId(aid);
  const requestedCycle = Array.isArray(query.cycle) ? null : query.cycle;
  const cycle = loadSeasonalCycleConfig();
  if (parsedAid === null || !isSeasonalRolloutReady() || !cycle || (requestedCycle && requestedCycle !== cycle.cycleId)) {
    return <ModeUnavailable seasonal />;
  }
  const levels = await getPlayerLevels().catch(() => []);
  return <SeasonalPlayer aid={parsedAid} cycleId={cycle.cycleId} levelBands={cumulativeLevelBands(levels)} />;
}
