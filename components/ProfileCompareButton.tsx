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

  return <button type="button" className="ghost-button profile-icon-button" aria-label={t("compare.button")} title={t("compare.button")} disabled={!scope} onClick={compare}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M4 7h16m-4-4 4 4-4 4M20 17H4m4-4-4 4 4 4" /></svg>
  </button>;
}
