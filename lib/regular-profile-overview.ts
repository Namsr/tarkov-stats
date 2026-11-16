import type { ProfileViewMetric } from "@/types/profile-view";
import type { ParsedPlayerStats } from "@/types/tarkov";

export interface RegularProfileOverview {
  nickname: string;
  pmcKdRatio: number | null;
  pmcSurvivalRate: number | null;
  pmcRaids: number | null;
  hoursPlayed: number | null;
}

function finite(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

export function regularProfileOverview(stats: ParsedPlayerStats): RegularProfileOverview {
  return {
    nickname: typeof stats.nickname === "string" ? stats.nickname : "",
    pmcKdRatio: stats.pvpStatsKnown === false ? null : finite(stats.pmcKdRatio),
    pmcSurvivalRate: stats.regularRiskInputs?.survived === null ? null : finite(stats.pmcSurvivalRate),
    pmcRaids: finite(stats.pmcRaids),
    hoursPlayed: finite(stats.hoursPlayed),
  };
}

export function regularProfileCards(
  overview: RegularProfileOverview,
  t: (key: string) => string,
  lang: string,
): ProfileViewMetric[] {
  return [
    { label: t("player.pmcKd"), value: overview.pmcKdRatio ?? t("common.notAvailable") },
    {
      label: t("player.survivalRate"),
      value: overview.pmcSurvivalRate ?? t("common.notAvailable"),
      suffix: overview.pmcSurvivalRate == null ? undefined : "%",
    },
    { label: t("player.pmcRaids"), value: overview.pmcRaids ?? t("common.notAvailable") },
    { label: t("metric.hours"), value: overview.hoursPlayed?.toLocaleString(lang, { maximumFractionDigits: 0 }) ?? t("common.notAvailable") },
  ];
}
