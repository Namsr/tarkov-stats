import { Suspense } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import RegularPlayer from "@/components/RegularPlayer";
import ModeUnavailable from "@/components/ModeUnavailable";
import { ProfileShellLoading } from "@/components/ProfileShell";
import SeasonalPlayer from "@/components/SeasonalPlayer";
import { isSeasonalRolloutReady, loadSeasonalCycleConfig } from "@/lib/seasonal/config";
import { cumulativeLevelBands } from "@/lib/seasonal/ui";
import { PLAYER_LEVELS_V2026_07_22 } from "@/lib/tarkov-api";
import { parsePlayerId } from "@/lib/player-id";
import { gameModeFromAppRoute } from "@/types/seasonal";

interface Props {
  params: Promise<{ segments?: string[] }>;
  searchParams: Promise<{ cycle?: string | string[]; radarDemo?: string | string[] }>;
}

function SeasonalPlayerRoute({ aid, cycleId }: { aid: number; cycleId: string }) {
  // Level bands are presentation metadata. Keep the remote reference fetch
  // out of the mode-switch critical path; this versioned table is also the
  // parser's validated fallback.
  return (
    <SeasonalPlayer
      aid={aid}
      cycleId={cycleId}
      levelBands={cumulativeLevelBands(PLAYER_LEVELS_V2026_07_22)}
    />
  );
}

export default async function CanonicalPlayerPage({ params, searchParams }: Props) {
  await connection();
  const route = await params;
  const query = await searchParams;
  const segments = route.segments ?? [];
  const routeMode = segments.length === 1 ? "regular" : segments[0];
  const mode = gameModeFromAppRoute(routeMode);
  const aid = segments.length === 1 ? segments[0] : segments[1];
  if (segments.length < 1 || segments.length > 2 || !aid || !mode) notFound();
  const parsedAid = parsePlayerId(aid);
  if (parsedAid === null) notFound();
  if (mode !== "seasonal") {
    return (
      <RegularPlayer
        mode={mode}
        params={Promise.resolve({ aid })}
        searchParams={Promise.resolve({ radarDemo: query.radarDemo })}
      />
    );
  }
  const requestedCycle = Array.isArray(query.cycle) ? null : query.cycle;
  const cycle = loadSeasonalCycleConfig();
  if (!isSeasonalRolloutReady() || !cycle || (requestedCycle && requestedCycle !== cycle.cycleId)) {
    return <ModeUnavailable seasonal />;
  }
  return (
    <Suspense fallback={<ProfileShellLoading mode="seasonal" aid={parsedAid} />}>
      <SeasonalPlayerRoute aid={parsedAid} cycleId={cycle.cycleId} />
    </Suspense>
  );
}
