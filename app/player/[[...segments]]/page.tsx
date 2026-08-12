import { Suspense } from "react";
import { connection } from "next/server";
import RegularPlayer from "@/components/RegularPlayer";
import ModeUnavailable from "@/components/ModeUnavailable";
import ProfileModeSwitch from "@/components/ProfileModeSwitch";
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

async function SeasonalPlayerRoute({ aid, cycleId }: { aid: number; cycleId: string }) {
  const levels = await getPlayerLevels().catch(() => []);
  return <SeasonalPlayer aid={aid} cycleId={cycleId} levelBands={cumulativeLevelBands(levels)} />;
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
  const parsedAid = parsePlayerId(aid);
  const modeSwitch = parsedAid === null ? null : (
    <div className="profile-route-modebar">
      <ProfileModeSwitch current={mode} page="player" aid={parsedAid} />
    </div>
  );
  if (mode !== "seasonal") {
    return (
      <>
        {modeSwitch}
        <RegularPlayer
          mode={mode}
          params={Promise.resolve({ aid })}
          searchParams={Promise.resolve({ radarDemo: query.radarDemo })}
        />
      </>
    );
  }
  const requestedCycle = Array.isArray(query.cycle) ? null : query.cycle;
  const cycle = loadSeasonalCycleConfig();
  if (parsedAid === null) return <ModeUnavailable seasonal />;
  if (!isSeasonalRolloutReady() || !cycle || (requestedCycle && requestedCycle !== cycle.cycleId)) {
    return (
      <>
        {modeSwitch}
        <ModeUnavailable seasonal />
      </>
    );
  }
  return (
    <>
      {modeSwitch}
      <Suspense fallback={null}>
        <SeasonalPlayerRoute aid={parsedAid} cycleId={cycle.cycleId} />
      </Suspense>
    </>
  );
}
