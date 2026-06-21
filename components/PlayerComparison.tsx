"use client";

import { useState, useEffect, useCallback } from "react";
import { useI18n } from "@/lib/i18n/context";
import { ParsedPlayerStats, Streamer, PlayerSearchResult } from "@/types/tarkov";
import { searchPlayerDirect, getProfileDirect } from "@/lib/player-api-client";
import { parseProfileStats } from "@/lib/tarkov-api";
import { rangeForHours } from "@/lib/playtime-brackets";
import ComparisonTable from "./ComparisonTable";
import StreamerList from "./StreamerList";
import PercentileBadge from "./PercentileBadge";
import streamersData from "@/data/streamers.json";

type Mode = "benchmark" | "player";

interface AverageData {
  /** Players sampled in the bracket. */
  n: number;
  /** Per-metric averages keyed by DB column (kd_ratio, survival_rate, ...). */
  averages: Record<string, number | null>;
}

interface Props {
  stats: ParsedPlayerStats;
  turnstileToken: string;
}

export default function PlayerComparison({ stats, turnstileToken }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("benchmark");
  const [avgData, setAvgData] = useState<AverageData | null>(null);
  const [avgError, setAvgError] = useState("");
  const [otherStats, setOtherStats] = useState<ParsedPlayerStats | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<PlayerSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const streamers: Streamer[] = streamersData;

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

  const fetchPlayerByNickname = useCallback(async (nickname: string) => {
    setLoading(true);
    setError("");
    setOtherStats(null);
    try {
      const results = await searchPlayerDirect(nickname, turnstileToken);
      if (results.length === 0) {
        setError(t("compare.errPlayerNotFound"));
        setLoading(false);
        return;
      }
      const profile = await getProfileDirect(results[0].aid, turnstileToken);
      setOtherStats(parseProfileStats(profile));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("compare.errFetchPlayer"));
    }
    setLoading(false);
  }, [turnstileToken, t]);

  async function handleSearch() {
    if (searchQuery.length < 2) return;
    setLoading(true);
    setError("");
    try {
      const data = await searchPlayerDirect(searchQuery, turnstileToken);
      if (data.length === 0) {
        setError(t("compare.errNoPlayers"));
        setSearchResults([]);
      } else if (data.length === 1) {
        await fetchPlayerByAid(data[0].aid);
        setSearchResults([]);
      } else {
        setSearchResults(data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t("compare.errSearch"));
    }
    setLoading(false);
  }

  async function fetchPlayerByAid(aid: number) {
    setLoading(true);
    setError("");
    setOtherStats(null);
    setSearchResults([]);
    try {
      const profile = await getProfileDirect(aid, turnstileToken);
      setOtherStats(parseProfileStats(profile));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("compare.errFetchPlayer"));
    }
    setLoading(false);
  }

  function handleStreamerSelect(streamer: Streamer) {
    setMode("player");
    setSearchQuery(streamer.nickname);
    fetchPlayerByNickname(streamer.nickname);
  }

  const comparisonRows = otherStats
    ? [
        { label: t("compare.totalRaids"), valueA: stats.totalRaids, valueB: otherStats.totalRaids },
        { label: t("compare.survivalRate"), valueA: stats.survivalRate, valueB: otherStats.survivalRate, suffix: "%" },
        { label: t("compare.kdRatio"), valueA: stats.kdRatio, valueB: otherStats.kdRatio },
        { label: t("compare.totalKills"), valueA: stats.totalKills, valueB: otherStats.totalKills },
        { label: t("compare.killsPerRaid"), valueA: stats.killsPerRaid, valueB: otherStats.killsPerRaid },
        { label: t("compare.headshotRate"), valueA: stats.headshotRate, valueB: otherStats.headshotRate, suffix: "%" },
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
                          <span className="text-[var(--accent)] font-medium">
                            {t("compare.you")}: {row.player.toFixed(2)}
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
              placeholder={t("compare.nicknamePlaceholder")}
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

          {searchResults.length > 1 && (
            <ul className="bg-[var(--input-bg)] border border-[var(--card-border)] rounded max-h-40 overflow-y-auto">
              {searchResults.map((r) => (
                <li key={r.aid}>
                  <button
                    onClick={() => fetchPlayerByAid(r.aid)}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-[var(--accent)]/10 flex justify-between"
                  >
                    <span>{r.name}</span>
                    <span className="text-gray-500 text-xs">#{r.aid}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {error && <p className="text-sm text-[var(--danger)]">{error}</p>}

          <StreamerList
            streamers={streamers}
            onSelect={handleStreamerSelect}
            loading={loading}
          />

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
