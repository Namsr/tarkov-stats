"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import ArenaRadar from "@/components/ArenaRadar";
import {
  ARENA_METRIC_KEYS,
  toArenaCohort,
} from "@/components/arena-ui";
import { arenaCounterValue, formatArenaMetric } from "@/components/arena-ui";
import type {
  ArenaCohortResult,
  ArenaCounters,
  ArenaMetricKey,
  ArenaModeKey,
  ArenaModeStats,
  ArenaStatistic,
} from "@/types/arena";

interface Props {
  aid: number;
  mode: ArenaModeKey;
  player: ArenaModeStats;
  statistic: ArenaStatistic;
  favorite?: ArenaModeStats | null;
  favoriteName?: string | null;
}

const COUNTER_KEYS: Array<{ key: keyof ArenaCounters; labelKey: string }> = [
  { key: "matches", labelKey: "arena.counter.matches" },
  { key: "wins", labelKey: "arena.counter.wins" },
  { key: "losses", labelKey: "arena.counter.losses" },
  { key: "kills", labelKey: "arena.counter.kills" },
  { key: "deaths", labelKey: "arena.counter.deaths" },
  { key: "assists", labelKey: "arena.counter.assists" },
  { key: "headshots", labelKey: "arena.counter.headshots" },
  { key: "damage", labelKey: "arena.counter.damage" },
  { key: "round_mvp", labelKey: "arena.counter.roundMvp" },
  { key: "match_mvp", labelKey: "arena.counter.matchMvp" },
  { key: "current_kill_streak", labelKey: "arena.counter.currentKillStreak" },
  { key: "max_kill_streak", labelKey: "arena.counter.maxKillStreak" },
  { key: "current_win_streak", labelKey: "arena.counter.currentWinStreak" },
  { key: "max_win_streak", labelKey: "arena.counter.maxWinStreak" },
  { key: "current_loss_streak", labelKey: "arena.counter.currentLossStreak" },
  { key: "max_loss_streak", labelKey: "arena.counter.maxLossStreak" },
];

function formatCounter(value: number | null): string {
  return value == null || !Number.isFinite(value) ? "—" : Math.round(value).toLocaleString();
}

export default function ArenaModeComparison({
  aid,
  mode,
  player,
  statistic,
  favorite,
  favoriteName,
}: Props) {
  const { t } = useI18n();
  const [cohort, setCohort] = useState<ArenaCohortResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError("");
    setCohort(null);
    const query = new URLSearchParams({
      mode: "arena",
      aid: String(aid),
      arenaMode: mode,
      statistic,
    });
    fetch(`/api/average/cohort?${query.toString()}`, { signal: controller.signal })
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
  const cohortReady = Boolean(cohort && cohort.quality === "sufficient" && cohort.sampleN >= required);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="section-kicker">{t("arena.radar.kicker")}</p>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {loading
              ? t("arena.radar.loading")
              : error
                ? error
                : cohortReady
                  ? t("arena.radar.matchedReady", { n: cohort?.sampleN.toLocaleString() ?? "0", percent: cohort?.percent ?? 30 })
                  : t("arena.radar.insufficient", { n: cohort?.sampleN ?? 0, target: required })}
          </p>
        </div>
        <span className="sample-status">
          {t(statistic === "median" ? "arena.statistic.median" : "arena.statistic.trimmedMean")}
        </span>
      </div>

      <ArenaRadar
        player={player}
        cohort={cohort}
        favorite={favorite}
        favoriteName={favoriteName}
        cohortReady={cohortReady}
      />

      <details className="compact-details">
        <summary>{t("arena.details.heading")}</summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[24rem] table-fixed border-collapse text-sm">
            <thead>
              <tr className="border-b border-[var(--card-border)] text-[10px] uppercase tracking-wider text-[var(--muted)]">
                <th scope="col" className="w-[62%] px-2 py-2 text-left">{t("arena.details.counter")}</th>
                <th scope="col" className="w-[38%] px-2 py-2 text-right">{t("arena.details.value")}</th>
              </tr>
            </thead>
            <tbody>
              {COUNTER_KEYS.map(({ key, labelKey }) => (
                <tr key={key} className="border-b border-[var(--card-border)]/60 last:border-0">
                  <th scope="row" className="px-2 py-2 text-left font-medium text-[var(--muted-strong)]">{t(labelKey)}</th>
                  <td className="px-2 py-2 text-right tabular-nums text-[var(--foreground)]">{formatCounter(arenaCounterValue(player, key))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <div className="sr-only">
        {ARENA_METRIC_KEYS.map((metric: ArenaMetricKey) => formatArenaMetric(player.metrics[metric], metric)).join(" ")}
      </div>
    </div>
  );
}
