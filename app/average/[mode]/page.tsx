import { connection } from "next/server";
import LegacyAveragePage from "@/app/average/page";
import ModeUnavailable from "@/components/ModeUnavailable";
import { isSeasonalRolloutReady, loadSeasonalCycleConfig } from "@/lib/seasonal/config";
import { cumulativeLevelBands } from "@/lib/seasonal/ui";
import { getPlayerLevels } from "@/lib/tarkov-api";
import { isGameMode } from "@/types/seasonal";

interface Props {
  params: Promise<{ mode: string }>;
  searchParams: Promise<{ cycle?: string | string[] }>;
}

export default async function CanonicalAveragePage({ params, searchParams }: Props) {
  await connection();
  const { mode } = await params;
  if (!isGameMode(mode)) return <ModeUnavailable />;
  if (mode === "regular") {
    const levels = await getPlayerLevels().catch(() => []);
    return <LegacyAveragePage mode={mode} levelBands={cumulativeLevelBands(levels)} />;
  }
  if (mode !== "seasonal") return <LegacyAveragePage mode={mode} />;
  const cycle = loadSeasonalCycleConfig();
  const requestedCycle = (await searchParams).cycle;
  if (!isSeasonalRolloutReady() || !cycle || Array.isArray(requestedCycle) || (requestedCycle && requestedCycle !== cycle.cycleId)) {
    return <ModeUnavailable seasonal />;
  }
  const levels = await getPlayerLevels().catch(() => []);
  return <LegacyAveragePage mode="seasonal" cycleId={cycle.cycleId} levelBands={cumulativeLevelBands(levels)} />;
}
