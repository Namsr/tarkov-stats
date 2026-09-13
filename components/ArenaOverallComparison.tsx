"use client";

import { useEffect, useState } from "react";
import ProfileRadar from "@/components/ProfileRadar";
import { toArenaCohort, ARENA_METRIC_KEYS } from "@/components/arena-ui";
import { useI18n } from "@/lib/i18n/context";
import type {
  ArenaCohortResult,
  ArenaOverallStats,
  ArenaStatistic,
  ArenaModeStats,
  ArenaStoredMode,
} from "@/types/arena";

export default function ArenaOverallComparison({
  aid,
  player,
  statistic,
  favorite,
  favoriteName,
  mode = "overall",
  playerName,
  compareFavorite = false,
}: {
  aid: number;
  player: ArenaOverallStats | ArenaModeStats;
  statistic: ArenaStatistic;
  favorite?: ArenaOverallStats | ArenaModeStats | null;
  favoriteName?: string | null;
  mode?: ArenaStoredMode;
  playerName?: string;
  compareFavorite?: boolean;
}) {
  const { t } = useI18n();
  const [cohort, setCohort] = useState<ArenaCohortResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const query = new URLSearchParams({
      mode: "arena",
      aid: String(aid),
      arenaMode: mode,
      statistic,
    });
    setLoading(true);
    setError("");
    setCohort(null);
    fetch(`/api/average/cohort?${query}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(t("arena.radar.error"));
        const result = toArenaCohort(body);
        if (!result || result.aid !== aid || result.mode !== mode || result.statistic !== statistic) {
          throw new Error(t("arena.radar.error"));
        }
        return result;
      })
      .then((result) => {
        if (active) setCohort(result);
      })
      .catch((caught: unknown) => {
        if (!active || (caught instanceof Error && caught.name === "AbortError")) return;
        setCohort(null);
        setError(caught instanceof Error ? caught.message : t("arena.radar.error"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [aid, mode, statistic, t]);

  const required = Math.max(20, cohort?.required ?? 20);
  const cohortReady = Boolean(cohort && cohort.mode === mode && cohort.statistic === statistic && cohort.quality === "sufficient" && cohort.sampleN >= required);
  const rows = ARENA_METRIC_KEYS.map((key) => {
    const average = cohort?.metrics[key];
    const baseline = cohortReady && average?.value != null && average.value > 0 && average.count >= 20 ? average.value : null;
    return {
      key, label: t("arena.metric." + key), shortLabel: t("profile.arenaAxis." + key),
      a: player.metrics[key], b: compareFavorite ? favorite?.metrics[key] ?? null : baseline,
      baseline, digits: key === "damage_per_match" ? 0 : key === "win_rate" || key === "headshot_rate" ? 1 : 2,
      percent: key === "win_rate" || key === "headshot_rate",
    };
  });
  return <div aria-busy={loading || undefined}>
    {(loading || error) && <p className="profile-chart-notice" role="status">{error || t("arena.radar.loading")}</p>}
    <ProfileRadar key={`${aid}:${mode}:${statistic}:${compareFavorite}:${favoriteName}`} metrics={rows} playerName={playerName || t("radar.series.player")} otherName={compareFavorite ? favoriteName || t("radar.series.favorite") : t("radar.series.average")} />
  </div>;
}
