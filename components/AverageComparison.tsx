"use client";

import { useI18n } from "@/lib/i18n/context";
import { previewRatio } from "@/lib/leaderboard-preview";

export default function AverageComparison({ value, average }: { value: number | null; average: number | null }) {
  const { t, lang } = useI18n();
  const comparison = previewRatio(value, average);
  if (!comparison) return null;
  const { direction, ratio } = comparison;
  const label = direction === "equal" ? t("common.atAverage")
    : ratio === null ? t(direction === "above" ? "common.aboveAverage" : "common.belowAverage")
      : t(direction === "above" ? "common.aboveAverageTimes" : "common.belowAverageTimes", {
        n: ratio.toLocaleString(lang, { maximumFractionDigits: 2 }),
      });
  return <span className="profile-average-comparison" data-direction={direction}>{label}</span>;
}
