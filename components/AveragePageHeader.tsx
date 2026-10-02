"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import CompactDetails from "@/components/CompactDetails";
import ProfileModeSwitch from "@/components/ProfileModeSwitch";
import SegmentedRadio from "@/components/SegmentedRadio";
import { useI18n } from "@/lib/i18n/context";
import type { AveragePeriod, AverageStatistic } from "@/lib/db";
import type { GameMode } from "@/types/seasonal";
import { useEffect } from "react";
import { cancelAveragePrefetches, scheduleAveragePrefetch } from "@/lib/client-average-request";

export default function AveragePageHeader({
  current,
  statistic,
  onStatisticChange,
  period,
  onPeriodChange,
  onBeforeNavigate,
  seasonalCycleId,
}: {
  current: GameMode;
  statistic: AverageStatistic;
  onStatisticChange: (value: AverageStatistic) => void;
  period?: AveragePeriod;
  onPeriodChange?: (value: AveragePeriod) => void;
  onBeforeNavigate?: (mode: GameMode) => void;
  seasonalCycleId?: string;
}) {
  const { t } = useI18n();
  const pathname = usePathname();
  const isPopulation = pathname === "/population" || pathname.startsWith("/population/");

  useEffect(() => {
    const selectedPeriod = period ?? "all";
    const standard = (mode: "regular" | "pve") => `/api/average?${new URLSearchParams({
      dimension: "hours", metric: "players", statistic, period: selectedPeriod, mode,
    })}`;
    const urls = [standard("regular"), standard("pve"), `/api/average?${new URLSearchParams({
      mode: "arena", arenaMode: "teamFight", statistic, dimension: "matches", metric: "players",
    })}`];
    if (seasonalCycleId) {
      const seasonal = new URLSearchParams({ dimension: "hours", metric: "players", statistic, period: selectedPeriod });
      seasonal.set("cycle", seasonalCycleId);
      urls.push(`/api/seasonal/average?${seasonal}`);
    }
    scheduleAveragePrefetch(urls);
    return () => cancelAveragePrefetches();
  }, [period, seasonalCycleId, statistic]);

  return (
    <>
      <Link
        href="/"
        className="inline-block text-sm text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
      >
        {t("common.back")}
      </Link>
      <div className="average-hero">
        {isPopulation ? (
          <h1 className="page-title">{t("nav.population")}</h1>
        ) : (
          <h1 className="page-title">{t("nav.average")}</h1>
        )}
        <ProfileModeSwitch
          current={current}
          page="average"
          seasonalCycleId={seasonalCycleId}
          onBeforeNavigate={onBeforeNavigate}
        />
      </div>

      <section className="average-toolbar" aria-label={t("average.settings")}>
        <SegmentedRadio
          name="average-statistic"
          legend={t("average.statistic.label")}
          value={statistic}
          options={[
            { value: "trimmed_mean", label: t("average.statistic.trimmedMean") },
            { value: "median", label: t("average.statistic.median") },
          ]}
          onChange={onStatisticChange}
        />
        {period !== undefined && onPeriodChange !== undefined && (
          <SegmentedRadio
            name="average-period"
            legend={t("average.period.label")}
            value={period}
            options={[
              { value: "all", label: t("average.period.all") },
              { value: "90d", label: t("average.period.last90Days") },
            ]}
            onChange={onPeriodChange}
          />
        )}
        <CompactDetails summary={t("average.calculation.help")}>
          {current === "arena" ? (
            <p>{t("arena.average.statisticNote")}</p>
          ) : (
            <div className="grid gap-3">
              <p>{t("average.robustNote")}</p>
              <p>{t("average.period.note")}</p>
            </div>
          )}
        </CompactDetails>
      </section>
    </>
  );
}
