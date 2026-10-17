"use client";

import { useRouter } from "next/navigation";
import { addComparisonPlayer, comparisonSelectionParams, readComparisonSelection, saveComparisonSelection } from "@/lib/comparison-selection";
import { useI18n } from "@/lib/i18n/context";
import type { ArenaStoredMode } from "@/types/arena";
import type { GameMode } from "@/types/seasonal";
import type { ComparisonScope } from "@/types/comparison";

export default function ProfileCompareButton({ aid, mode, cycleId, arenaMode = "overall" }: {
  aid: number;
  mode: GameMode;
  cycleId?: string;
  arenaMode?: ArenaStoredMode;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const scope: ComparisonScope | null = mode === "seasonal"
    ? cycleId ? { mode, cycleId, arenaMode: null } : null
    : mode === "arena" ? { mode, cycleId: "persistent", arenaMode }
      : { mode, cycleId: "persistent", arenaMode: null };

  function compare() {
    if (!scope) return;
    const selection = addComparisonPlayer(scope, aid, readComparisonSelection());
    const params = comparisonSelectionParams(selection);
    saveComparisonSelection(selection);
    router.push(`/compare?${params}`);
  }

  return <button type="button" className="ghost-button" disabled={!scope} onClick={compare}>
    {t("compare.button")}
  </button>;
}
