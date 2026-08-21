"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { ProfileShellLoading } from "@/components/ProfileShell";
import RegularPlayer from "@/components/RegularPlayer";
import SeasonalPlayer from "@/components/SeasonalPlayer";
import { parsePlayerId } from "@/lib/player-id";
import { PLAYER_LEVELS_V2026_07_22 } from "@/lib/tarkov-api";
import { cumulativeLevelBands } from "@/lib/seasonal/ui";
import { gameModeFromAppRoute, normalizeCycleId } from "@/types/seasonal";

export default function Loading() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const segments = pathname.split("/").filter(Boolean).slice(1);
  const routeMode = segments.length === 1 ? "regular" : segments[0];
  const aidValue = segments.length === 1 ? segments[0] : segments[1];
  const mode = gameModeFromAppRoute(routeMode) ?? "regular";
  const aid = aidValue ? parsePlayerId(aidValue) ?? undefined : undefined;

  if (aid != null && mode !== "seasonal") {
    return (
      <RegularPlayer
        key={`${mode}:${aid}`}
        aid={String(aid)}
        mode={mode}
        radarDemo={searchParams.get("radarDemo") ?? undefined}
      />
    );
  }
  const cycleId = normalizeCycleId(searchParams.get("cycle"), "seasonal");
  if (aid != null && mode === "seasonal" && cycleId) {
    return (
      <SeasonalPlayer
        key={`seasonal:${aid}:${cycleId}`}
        aid={aid}
        cycleId={cycleId}
        levelBands={cumulativeLevelBands(PLAYER_LEVELS_V2026_07_22)}
      />
    );
  }
  return <ProfileShellLoading mode={mode} aid={aid} />;
}
