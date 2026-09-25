import { connection } from "next/server";
import { Suspense } from "react";
import ComparePage from "@/components/ComparePage";
import { isSeasonalRolloutReady, loadSeasonalCycleConfig } from "@/lib/seasonal/config";

export default async function CompareRoutePage() {
  await connection();
  const cycle = loadSeasonalCycleConfig();
  const seasonalCycleId = isSeasonalRolloutReady() && cycle?.enabled ? cycle.cycleId : null;
  return (
    <Suspense fallback={<main className="page-frame" aria-busy="true" />}>
      <ComparePage seasonalCycleId={seasonalCycleId} />
    </Suspense>
  );
}
