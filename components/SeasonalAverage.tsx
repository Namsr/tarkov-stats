"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import SeasonalProgressionChart from "@/components/SeasonalProgressionChart";
import { useI18n } from "@/lib/i18n/context";
import type { LevelBand } from "@/lib/seasonal/ui";
import type { SeasonalAverageResponse } from "@/types/seasonal";
import ProfileModeSwitch from "@/components/ProfileModeSwitch";

export default function SeasonalAverage({ cycleId, levelBands }: { cycleId: string; levelBands: LevelBand[] }) {
  const { t } = useI18n();
  const [data, setData] = useState<SeasonalAverageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ cycle: cycleId });
    fetch(`/api/seasonal/average?${params}`, { signal: controller.signal })
      .then(async (response) => {
      if (!response.ok) throw new Error(t("seasonal.progressionUnavailable"));
        return (await response.json()) as SeasonalAverageResponse;
      })
      .then(setData)
      .catch((caught: unknown) => {
        if (caught instanceof Error && caught.name === "AbortError") return;
        setData(null);
        setError(t("seasonal.progressionUnavailable"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [cycleId, t]);

  const population = data?.population;

  return (
    <main className="page-frame">
      <Link href="/" className="text-sm text-[var(--muted)] hover:text-[var(--foreground)]">{t("common.back")}</Link>
      <div className="mt-7 flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="page-kicker">{t("seasonal.averageKicker", { cycle: cycleId })}</p>
          <h1 className="page-title">{t("seasonal.averageTitle")}</h1>
          <p className="mt-4 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">{t("seasonal.averageDescription")}</p>
        </div>
        <ProfileModeSwitch current="seasonal" page="average" />
      </div>
      {loading && <p className="mt-5 text-sm text-[var(--muted)]">{t("common.loading")}</p>}
      {error && <p className="mt-5 text-sm text-[var(--muted)]">{error}</p>}
      {population && (
        <section className="data-panel mt-6">
          <p className="section-kicker">{t("seasonal.averageBase")}</p>
          <h2 className="section-heading">{t("seasonal.averageAccounts", { n: population.n.toLocaleString() })}</h2>
          <h3 className="mt-5 text-sm font-semibold">{t("seasonal.averagePortrait")}</h3>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {([
              ["experience", "seasonal.averageExperience", 0],
              ["pmcRaids", "seasonal.averagePmcRaids", 1],
              ["scavRaids", "seasonal.averageScavRaids", 1],
              ["pmcKills", "seasonal.averagePmcKills", 1],
              ["killedPmc", "seasonal.averageKilledPmc", 1],
              ["pmcSurvivalRate", "seasonal.averagePmcSurvival", 1],
            ] as const).map(([key, label, decimals]) => {
              const value = population.averages[key];
              return (
                <div key={key} className="rounded-lg border border-[var(--border)] p-3">
                  <div className="text-xl font-semibold">
                    {value == null ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: decimals })}
                    {key === "pmcSurvivalRate" && value != null ? "%" : ""}
                  </div>
                  <div className="mt-1 text-xs text-[var(--muted)]">{t(label)}</div>
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-sm text-[var(--muted)]">{t("seasonal.averageFreshnessDescription")}</p>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {([
              ["last24Hours", "seasonal.freshness24h"],
              ["last72Hours", "seasonal.freshness72h"],
              ["last7Days", "seasonal.freshness7d"],
              ["older", "seasonal.freshnessOlder"],
            ] as const).map(([key, label]) => (
              <div key={key} className="rounded-lg border border-[var(--border)] p-3">
                <div className="text-xl font-semibold">{population.freshness[key].toLocaleString()}</div>
                <div className="mt-1 text-xs text-[var(--muted)]">{t(label)}</div>
              </div>
            ))}
          </div>
        </section>
      )}
      {data?.series.cumulative && <SeasonalProgressionChart data={data.series.cumulative} title={t("seasonal.chart.xpOverall")} levelBands={levelBands} averageOnly />}
      {data?.series.tempo && <SeasonalProgressionChart data={data.series.tempo} title={t("seasonal.chart.tempoOverall")} averageOnly />}
      {data?.series.form && <SeasonalProgressionChart data={data.series.form} title={t("seasonal.chart.formOverall")} averageOnly />}
    </main>
  );
}
