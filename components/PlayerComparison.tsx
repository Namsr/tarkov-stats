"use client";

import { useState, useEffect, useCallback } from "react";
import { ParsedPlayerStats, BenchmarkBucket, Streamer, PlayerSearchResult } from "@/types/tarkov";
import { searchPlayerDirect, getProfileDirect } from "@/lib/player-api-client";
import { parseProfileStats } from "@/lib/tarkov-api";
import ComparisonTable from "./ComparisonTable";
import StreamerList from "./StreamerList";
import PercentileBadge from "./PercentileBadge";
import streamersData from "@/data/streamers.json";

type Mode = "benchmark" | "player";

interface Props {
  stats: ParsedPlayerStats;
  turnstileToken: string;
}

export default function PlayerComparison({ stats, turnstileToken }: Props) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("benchmark");
  const [benchmarks, setBenchmarks] = useState<BenchmarkBucket[]>([]);
  const [otherStats, setOtherStats] = useState<ParsedPlayerStats | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<PlayerSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const streamers: Streamer[] = streamersData;

  useEffect(() => {
    if (open && benchmarks.length === 0) {
      fetch("/api/benchmarks")
        .then((r) => r.json())
        .then(setBenchmarks)
        .catch(() => {});
    }
  }, [open, benchmarks.length]);

  const matchedBucket = benchmarks.find(
    (b) => stats.totalRaids >= b.minRaids && stats.totalRaids <= b.maxRaids
  );

  const fetchPlayerByNickname = useCallback(async (nickname: string) => {
    setLoading(true);
    setError("");
    setOtherStats(null);
    try {
      const results = await searchPlayerDirect(nickname, turnstileToken);
      if (results.length === 0) {
        setError("Player not found");
        setLoading(false);
        return;
      }
      const profile = await getProfileDirect(results[0].aid, turnstileToken);
      setOtherStats(parseProfileStats(profile));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch player");
    }
    setLoading(false);
  }, [turnstileToken]);

  async function handleSearch() {
    if (searchQuery.length < 2) return;
    setLoading(true);
    setError("");
    try {
      const data = await searchPlayerDirect(searchQuery, turnstileToken);
      if (data.length === 0) {
        setError("No players found");
        setSearchResults([]);
      } else if (data.length === 1) {
        await fetchPlayerByAid(data[0].aid);
        setSearchResults([]);
      } else {
        setSearchResults(data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
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
      setError(err instanceof Error ? err.message : "Failed to fetch player");
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
        { label: "Total Raids", valueA: stats.totalRaids, valueB: otherStats.totalRaids },
        { label: "Survival Rate", valueA: stats.survivalRate, valueB: otherStats.survivalRate, suffix: "%" },
        { label: "K/D Ratio", valueA: stats.kdRatio, valueB: otherStats.kdRatio },
        { label: "Total Kills", valueA: stats.totalKills, valueB: otherStats.totalKills },
        { label: "Kills/Raid", valueA: stats.killsPerRaid, valueB: otherStats.killsPerRaid },
        { label: "Headshot Rate", valueA: stats.headshotRate, valueB: otherStats.headshotRate, suffix: "%" },
        { label: "Hours Played", valueA: stats.hoursPlayed, valueB: otherStats.hoursPlayed },
        { label: "Avg Lifespan", valueA: stats.avgLifespan, valueB: otherStats.avgLifespan, suffix: " min" },
        { label: "Win Streak", valueA: stats.longestWinStreak, valueB: otherStats.longestWinStreak },
        { label: "Achievements", valueA: stats.achievementsCount, valueB: otherStats.achievementsCount },
        { label: "Level", valueA: stats.level, valueB: otherStats.level },
      ]
    : [];

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="px-4 py-2 bg-[var(--accent)] text-[var(--background)] rounded font-medium hover:bg-[var(--accent-dim)] transition-colors"
      >
        Compare
      </button>
    );
  }

  return (
    <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-[var(--accent)]">Comparison</h2>
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
          vs Average
        </button>
        <button
          onClick={() => setMode("player")}
          className={`px-3 py-1.5 text-sm rounded transition-colors ${
            mode === "player"
              ? "bg-[var(--accent)] text-[var(--background)]"
              : "bg-[var(--input-bg)] text-gray-400 hover:text-gray-200"
          }`}
        >
          vs Player
        </button>
      </div>

      {mode === "benchmark" && (
        <div className="space-y-4">
          {matchedBucket ? (
            <>
              <p className="text-sm text-gray-400">
                Your bracket:{" "}
                <span className="text-[var(--accent)]">{matchedBucket.label}</span>
                {" "}({matchedBucket.sampleSize} players sampled)
              </p>
              <div className="space-y-3">
                {[
                  { label: "K/D Ratio", player: stats.kdRatio, median: matchedBucket.medianKD },
                  { label: "Survival Rate", player: stats.survivalRate, median: matchedBucket.medianSurvivalRate },
                  { label: "Kills/Raid", player: stats.killsPerRaid, median: matchedBucket.medianKillsPerRaid },
                  { label: "Total Kills", player: stats.totalKills, median: matchedBucket.medianTotalKills },
                  { label: "Total Raids", player: stats.totalRaids, median: matchedBucket.medianRaids },
                ].map((row) => (
                  <div
                    key={row.label}
                    className="flex items-center justify-between py-2 border-b border-[var(--card-border)]/50"
                  >
                    <div className="flex flex-col">
                      <span className="text-sm text-gray-400">{row.label}</span>
                      <div className="flex items-center gap-3 mt-1">
                        <span className="text-[var(--accent)] font-medium">
                          You: {typeof row.player === "number" ? row.player.toFixed(2) : row.player}
                        </span>
                        <span className="text-gray-500">
                          Avg: {row.median.toFixed(2)}
                        </span>
                      </div>
                    </div>
                    <PercentileBadge
                      playerValue={row.player}
                      medianValue={row.median}
                    />
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="text-gray-500 text-sm">
              {benchmarks.length === 0
                ? "Loading benchmarks..."
                : "No matching benchmark bracket found."}
            </p>
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
              placeholder="Enter player nickname..."
              className="flex-1 px-3 py-2 bg-[var(--input-bg)] border border-[var(--card-border)] rounded text-sm focus:outline-none focus:border-[var(--accent)]"
            />
            <button
              onClick={handleSearch}
              disabled={loading}
              className="px-4 py-2 bg-[var(--accent)] text-[var(--background)] rounded text-sm font-medium hover:bg-[var(--accent-dim)] disabled:opacity-50"
            >
              {loading ? "..." : "Search"}
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
