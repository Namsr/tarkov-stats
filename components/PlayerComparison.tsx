"use client";

import { useState, useEffect } from "react";
import { useI18n } from "@/lib/i18n/context";
import { useFavorites } from "@/lib/favorites/context";
import { ParsedPlayerStats } from "@/types/tarkov";
import { parsePlayerId } from "@/lib/player-id";
import { rangeForHours } from "@/lib/playtime-brackets";
import ComparisonTable from "./ComparisonTable";
import PercentileBadge from "./PercentileBadge";

type Mode = "benchmark" | "player";

interface AverageData {
  /** Players sampled in the bracket. */
  n: number;
  /** Per-metric averages keyed by DB column (kd_ratio, survival_rate, ...). */
  averages: Record<string, number | null>;
}

interface Props {
  stats: ParsedPlayerStats;
}

export default function PlayerComparison({ stats }: Props) {
  const { t } = useI18n();
  const { enabled: favEnabled, favorites } = useFavorites();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("benchmark");
  const [avgData, setAvgData] = useState<AverageData | null>(null);
  const [avgError, setAvgError] = useState("");
  const [otherStats, setOtherStats] = useState<ParsedPlayerStats | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Match the player into the same playtime bracket the /average page uses and
  // pull that bracket's live averages (and real sample count) from the DB.
  const bracket = rangeForHours(stats.hoursPlayed);

  useEffect(() => {
    if (!open || mode !== "benchmark" || avgData) return;
    const params = new URLSearchParams();
    params.set("minHours", String(bracket.min));
    if (bracket.max != null) params.set("maxHours", String(bracket.max));

    let cancelled = false;
    fetch(`/api/average?${params.toString()}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const averages =
          (d as { averages?: Record<string, number | null> | null }).averages ?? {};
        setAvgData({ n: Number(averages.n ?? 0), averages });
      })
      .catch(() => {
        if (!cancelled) setAvgError(t("compare.errAverages"));
      });

    return () => {
      cancelled = true;
    };
  }, [open, mode, bracket.min, bracket.max, avgData, t]);

  // Compare against another account by id, via the server route (no captcha
  // needed) — same source the main player page uses, so stats include level.
  async function fetchPlayerByAid(aid: number) {
    setLoading(true);
    setError("");
    setOtherStats(null);
    try {
      const res = await fetch(`/api/player/profile?aid=${aid}`);
      const data = (await res.json()) as { stats?: ParsedPlayerStats; error?: string };
      if (!res.ok || !data.stats) throw new Error(data.error ?? t("compare.errFetchPlayer"));
      setOtherStats(data.stats);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("compare.errFetchPlayer"));
    }
    setLoading(false);
  }

  function handleSearch() {
    const aid = parsePlayerId(searchQuery);
    if (aid === null) {
      setError(t("search.error"));
      return;
    }
    fetchPlayerByAid(aid);
  }

  const comparisonRows = otherStats
    ? [
        { label: t("compare.totalRaids"), valueA: stats.totalRaids, valueB: otherStats.totalRaids },
        { label: t("compare.survivalRate"), valueA: stats.survivalRate, valueB: otherStats.survivalRate, suffix: "%" },
        { label: t("compare.kdRatio"), valueA: stats.kdRatio, valueB: otherStats.kdRatio },
        { label: t("compare.totalKills"), valueA: stats.totalKills, valueB: otherStats.totalKills },
        { label: t("compare.killsPerRaid"), valueA: stats.killsPerRaid, valueB: otherStats.killsPerRaid },
        { label: t("compare.hoursPlayed"), valueA: stats.hoursPlayed, valueB: otherStats.hoursPlayed },
        { label: t("compare.avgLifespan"), valueA: stats.avgLifespan, valueB: otherStats.avgLifespan, suffix: t("compare.minSuffix") },
        { label: t("compare.winStreak"), valueA: stats.longestWinStreak, valueB: otherStats.longestWinStreak },
        { label: t("compare.achievements"), valueA: stats.achievementsCount, valueB: otherStats.achievementsCount },
        { label: t("compare.level"), valueA: stats.level, valueB: otherStats.level },
      ]
    : [];

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="px-4 py-2 bg-[var(--accent)] text-[var(--background)] rounded font-medium hover:bg-[var(--accent-dim)] transition-colors"
      >
        {t("compare.button")}
      </button>
    );
  }

  return (
    <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-[var(--accent)]">{t("compare.heading")}</h2>
        <button
          onClick={() => setOpen(false)}
          className="text-gray-500 hover:text-gray-300 text-xl"
        >
          ✕
        </button>
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => setMode("benchmark")}
          className={`px-3 py-1.5 text-sm rounded transition-colors ${
            mode === "benchmark"
              ? "bg-[var(--accent)] text-[var(--background)]"
              : "bg-[var(--input-bg)] text-gray-400 hover:text-gray-200"
          }`}
        >
          {t("compare.vsAverage")}
        </button>
        <button
          onClick={() => setMode("player")}
          className={`px-3 py-1.5 text-sm rounded transition-colors ${
            mode === "player"
              ? "bg-[var(--accent)] text-[var(--background)]"
              : "bg-[var(--input-bg)] text-gray-400 hover:text-gray-200"
          }`}
        >
          {t("compare.vsPlayer")}
        </button>
      </div>

      {mode === "benchmark" && (
        <div className="space-y-4">
          {avgError ? (
            <p className="text-[var(--danger)] text-sm">{avgError}</p>
          ) : !avgData ? (
            <p className="text-gray-500 text-sm">{t("compare.loadingAverages")}</p>
          ) : avgData.n === 0 ? (
            <p className="text-gray-500 text-sm">
              {t("compare.yourBracket")}{" "}
              <span className="text-[var(--accent)]">{bracket.label} {t("unit.h")}</span>
              {" — "}
              {t("compare.noSample")}
            </p>
          ) : (
            <>
              <p className="text-sm text-gray-400">
                {t("compare.yourBracket")}{" "}
                <span className="text-[var(--accent)]">{bracket.label} {t("unit.h")}</span>{" "}
                ({t("compare.sampled", { n: avgData.n.toLocaleString() })})
              </p>
              <div className="space-y-3">
                {[
                  { label: t("compare.kdRatio"), player: stats.kdRatio, avg: avgData.averages.kd_ratio },
                  { label: t("compare.survivalRate"), player: stats.survivalRate, avg: avgData.averages.survival_rate },
                  { label: t("compare.killsPerRaid"), player: stats.killsPerRaid, avg: avgData.averages.kills_per_raid },
                  { label: t("compare.totalKills"), player: stats.totalKills, avg: avgData.averages.total_kills },
                  { label: t("compare.totalRaids"), player: stats.totalRaids, avg: avgData.averages.total_raids },
                ]
                  .filter((row): row is { label: string; player: number; avg: number } =>
                    typeof row.avg === "number"
                  )
                  .map((row) => (
                    <div
                      key={row.label}
                      className="flex items-center justify-between py-2 border-b border-[var(--card-border)]/50"
                    >
                      <div className="flex flex-col">
                        <span className="text-sm text-gray-400">{row.label}</span>
                        <div className="flex items-center gap-3 mt-1">
                          <span className="text-[var(--accent)] font-medium truncate max-w-[160px]">
                            {stats.nickname}: {row.player.toFixed(2)}
                          </span>
                          <span className="text-gray-500">{t("common.avg")}: {row.avg.toFixed(2)}</span>
                        </div>
                      </div>
                      <PercentileBadge playerValue={row.player} medianValue={row.avg} />
                    </div>
                  ))}
              </div>
            </>
          )}
        </div>
      )}

      {mode === "player" && (
        <div className="space-y-4">
          <div className="flex gap-2">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              placeholder={t("compare.idPlaceholder")}
              className="flex-1 px-3 py-2 bg-[var(--input-bg)] border border-[var(--card-border)] rounded text-sm focus:outline-none focus:border-[var(--accent)]"
            />
            <button
              onClick={handleSearch}
              disabled={loading}
              className="px-4 py-2 bg-[var(--accent)] text-[var(--background)] rounded text-sm font-medium hover:bg-[var(--accent-dim)] disabled:opacity-50"
            >
              {loading ? "..." : t("compare.search")}
            </button>
          </div>

          {error && <p className="text-sm text-[var(--danger)]">{error}</p>}

          {/* Quick-pick from the user's favorites (replaces the streamer list) */}
          <div>
            <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-2">
              {t("compare.favoritesHeading")}
            </h3>
            {!favEnabled ? (
              <p className="text-sm text-gray-500">{t("fav.authRequired")}</p>
            ) : favorites.length === 0 ? (
              <p className="text-sm text-gray-500">{t("profile.empty")}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {favorites.map((f) => (
                  <button
                    key={f.aid}
                    onClick={() => fetchPlayerByAid(f.aid)}
                    disabled={loading}
                    className="px-3 py-1.5 text-sm bg-[var(--card-bg)] border border-[var(--card-border)] rounded hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors disabled:opacity-50"
                  >
                    {f.nickname || `#${f.aid}`}
                  </button>
                ))}
              </div>
            )}
          </div>

          {otherStats && (
            <ComparisonTable
              nameA={stats.nickname}
              nameB={otherStats.nickname}
              rows={comparisonRows}
            />
          )}
        </div>
      )}
    </div>
  );
}
