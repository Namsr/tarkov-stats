"use client";

import { useEffect, useState } from "react";
import { loadArenaPopulationCohort, shouldFallbackToPopulation, toArenaCohort } from "@/components/arena-ui";
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
  const { t, lang } = useI18n();
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
        if (mode === "overall" || !shouldFallbackToPopulation(result)) {
          return result;
        }
        return await loadArenaPopulationCohort(
          aid,
          mode,
          statistic,
          body.schemaVersion,
          controller.signal,
        ) ?? result;
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
  const rows = (["headshot_rate", "kd_ratio", "win_rate", "kills_per_match", "damage_per_match"] as const).map((key) => {
    const average = cohort?.metrics[key];
    const baseline = cohortReady && average?.value != null && average.value > 0 && average.count >= 20 ? average.value : null;
    return {
      key, label: t("arena.metric." + key),
      a: player.metrics[key], b: compareFavorite ? favorite?.metrics[key] ?? null : baseline,
      baseline, digits: key === "damage_per_match" ? 0 : key === "win_rate" || key === "headshot_rate" ? 1 : 2,
      percent: key === "win_rate" || key === "headshot_rate",
    };
  });
  const format = (value: number | null, digits: number, percent = false) => value == null || !Number.isFinite(value)
    ? t("common.notAvailable") : value.toLocaleString(lang, { maximumFractionDigits: digits }) + (percent ? "%" : "");
  return <div className="arena-comparison-bars" aria-busy={loading || undefined}>
    {(loading || error) && <p className="profile-chart-notice" role="status">{error || t("arena.radar.loading")}</p>}
    <div className="arena-bars-legend"><span><i className="arena-bars-player-key" />{playerName || t("radar.series.player")}</span><span><i className="arena-bars-average-key" />{t("arena.combat.averageMarker")}</span>{compareFavorite && <span><i className="arena-bars-favorite-key" />{favoriteName || t("radar.series.favorite")}</span>}</div>
    {rows.map((row) => {
      const ratio = row.a != null && row.baseline != null ? row.a / row.baseline : null;
      const favoriteRatio = compareFavorite && row.b != null && row.baseline != null ? row.b / row.baseline : null;
      const difference = row.a != null && row.b != null ? row.percent ? row.a - row.b : row.b > 0 ? (row.a / row.b - 1) * 100 : null : null;
      return <div className="arena-comparison-row" key={row.key} data-arena-metric={row.key}>
        <div className="arena-comparison-row__heading"><div><h3>{row.label}</h3><p>{t("radar.series.average")}: {format(row.baseline, row.digits, row.percent)}</p>{compareFavorite && <p>{favoriteName || t("radar.series.favorite")}: {format(row.b, row.digits, row.percent)}</p>}</div>
          <div className="arena-comparison-row__value"><strong>{format(row.a, row.digits, row.percent)}</strong>
            {difference != null && <p>{difference > 0 ? "+" : ""}{format(difference, 1)}{row.percent ? ` ${t("arena.combat.pp")}` : "%"} {t(compareFavorite ? "arena.combat.vsFavorite" : "arena.combat.vsAverage")}</p>}
          </div>
        </div>
        <div className="arena-comparison-track" role="img" aria-label={`${row.label}: ${format(row.a, row.digits, row.percent)}; ${t("radar.series.average")}: ${format(row.baseline, row.digits, row.percent)}${compareFavorite ? `; ${favoriteName || t("radar.series.favorite")}: ${format(row.b, row.digits, row.percent)}` : ""}`}>
          {ratio != null && <span className="arena-comparison-fill" style={{ width: `${Math.max(0, Math.min(100, ratio * 50))}%` }} />}
          {row.baseline != null && <span className="arena-comparison-average" aria-hidden="true" />}
          {favoriteRatio != null && <span className="arena-comparison-favorite" style={{ left: `${Math.max(0, Math.min(100, favoriteRatio * 50))}%` }} aria-hidden="true" />}
        </div>
        {(ratio != null && ratio > 2 || favoriteRatio != null && favoriteRatio > 2) && <p className="arena-comparison-overflow">{t("arena.combat.overRange", { name: ratio != null && ratio > 2 ? playerName || t("radar.series.player") : favoriteName || t("radar.series.favorite") })}</p>}
      </div>;
    })}
    <div className="arena-comparison-axis" aria-hidden="true"><span>0×</span><span>1×</span><span>2×</span></div>
    <p className="arena-combat-footnote">{t("arena.combat.fixedAverage")}</p>
    {!loading && !error && <p className="arena-combat-footnote">{cohortReady
      ? t(cohort?.strategy === "population" ? "arena.radar.populationReady" : "arena.radar.matchedReady", { n: cohort?.sampleN.toLocaleString(lang) ?? "0", percent: cohort?.percent ?? 30 })
      : t("arena.radar.insufficient", { n: cohort?.sampleN ?? 0, target: required })}</p>}
  </div>;
}
