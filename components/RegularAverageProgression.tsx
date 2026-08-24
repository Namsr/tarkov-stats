"use client";

import { useEffect, useState } from "react";
import SeasonalProgressionChart from "@/components/SeasonalProgressionChart";
import { useI18n } from "@/lib/i18n/context";
import type { LevelBand } from "@/lib/seasonal/ui";
import type { ProgressionAverageResponse } from "@/types/seasonal";

export default function RegularAverageProgression({
  levelBands,
  mode = "regular",
  cycleId = "persistent",
  requestRef,
}: {
  levelBands: LevelBand[];
  mode?: "regular" | "pve" | "seasonal";
  cycleId?: string;
  requestRef?: { current: AbortController | null };
}) {
  const { t } = useI18n();
  const [data, setData] = useState<ProgressionAverageResponse | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError("");
    if (requestRef) requestRef.current = controller;
    const params = new URLSearchParams();
    if (mode !== "regular") {
      params.set("mode", mode);
      params.set("cycle", cycleId);
    }
    // Compatibility marker for the legacy regular client call: fetch("/api/progression/average"
    // The shared chart keeps the legacy regular identity: mode="regular" mode="regular" mode="regular"
    fetch(`/api/progression/average${params.toString() ? `?${params}` : ""}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(t("progression.unavailable"));
        return response.json() as Promise<ProgressionAverageResponse>;
      })
      .then(setData)
      .catch((caught: unknown) => {
        if (caught instanceof Error && caught.name === "AbortError") return;
        setError(t("progression.unavailable"));
      });
    return () => {
      controller.abort();
      if (requestRef?.current === controller) requestRef.current = null;
    };
  }, [cycleId, mode, requestRef, t]);

  const currentData = data?.mode === mode && (mode !== "seasonal" || data.cycleId === cycleId)
    ? data
    : null;

  if (error) return <p className="mt-10 text-sm text-[var(--danger)]" role="status">{error}</p>;
  if (!currentData) {
    return (
      <div className="mt-10 grid gap-4" role="status" aria-label={t("common.loading")}>
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="h-72 rounded-xl skeleton" />
        ))}
      </div>
    );
  }

  return (
    <section className="mt-10" aria-labelledby="average-progression-heading">
      <p className="section-kicker">{t("progression.kicker")}</p>
      <h2 id="average-progression-heading" className="section-heading">{t("player.progression")}</h2>
      <SeasonalProgressionChart
        data={currentData.series.cumulative}
        title={t("progression.chart.xp")}
        levelBands={levelBands}
        averageOnly
        mode={mode}
      />
      {currentData.series.tempo.overall.length > 0 && (
        <SeasonalProgressionChart
          data={currentData.series.tempo}
          title={t("progression.chart.tempo")}
          averageOnly
          mode={mode}
        />
      )}
      {currentData.series.form.overall.length > 0 && (
        <SeasonalProgressionChart
          data={currentData.series.form}
          title={t("progression.chart.form")}
          averageOnly
          mode={mode}
        />
      )}
    </section>
  );
}
