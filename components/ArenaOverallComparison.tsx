"use client";

import { useEffect, useState } from "react";
import ArenaRadar from "@/components/ArenaRadar";
import { toArenaCohort } from "@/components/arena-ui";
import { useI18n } from "@/lib/i18n/context";
import type {
  ArenaCohortResult,
  ArenaOverallStats,
  ArenaStatistic,
} from "@/types/arena";

export default function ArenaOverallComparison({
  aid,
  player,
  statistic,
  favorite,
  favoriteName,
}: {
  aid: number;
  player: ArenaOverallStats;
  statistic: ArenaStatistic;
  favorite?: ArenaOverallStats | null;
  favoriteName?: string | null;
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
      arenaMode: "overall",
      statistic,
    });
    setLoading(true);
    setError("");
    fetch(`/api/average/cohort?${query}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(t("arena.radar.error"));
        const result = toArenaCohort(body);
        if (!result || result.aid !== aid || result.mode !== "overall" || result.statistic !== statistic) {
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
  }, [aid, statistic, t]);

  const cohortReady = Boolean(cohort && cohort.quality === "sufficient");

  return (
    <div className="h-full" aria-busy={loading || undefined}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="section-kicker">{t("arena.overallComparison.kicker")}</p>
          <h2 className="section-heading mt-1">{t("arena.overallComparison.heading")}</h2>
        </div>
        <span className="sample-status">
          {t(statistic === "median" ? "arena.statistic.median" : "arena.statistic.trimmedMean")}
        </span>
      </div>
      <div className="min-h-5 text-sm text-[var(--muted)]" aria-live="polite">
        {loading
          ? t("arena.radar.loadingOverall")
          : error
            ? error
            : cohortReady
              ? t("arena.radar.overallPopulation", { n: cohort?.sampleN.toLocaleString() ?? "0" })
              : t("arena.radar.overallUnavailable")}
      </div>
      <div className="mt-3">
        <ArenaRadar
          player={player}
          cohort={cohort}
          favorite={favorite}
          favoriteName={favoriteName}
          cohortReady={cohortReady}
        />
      </div>
    </div>
  );
}
