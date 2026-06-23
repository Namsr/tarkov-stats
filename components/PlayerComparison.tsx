"use client";

import { useState, useEffect } from "react";
import { useI18n } from "@/lib/i18n/context";
import { useFavorites } from "@/lib/favorites/context";
import { ParsedPlayerStats } from "@/types/tarkov";
import { parsePlayerId } from "@/lib/player-id";
import { rangeForHours } from "@/lib/playtime-brackets";
import ComparisonTable, { type ComparisonRow } from "./ComparisonTable";

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

// Metrics shown in BOTH comparison modes — identical rows and widths; only the
// opponent column (the bracket average vs the picked player) differs. `avg` is the
// /api/average column name; `get` reads the same value off a ParsedPlayerStats.
const METRICS: {
  get: (s: ParsedPlayerStats) => number;
  avg: string;
  labelKey: string;
  decimals: number;
  suffix?: string;
}[] = [
  { get: (s) => s.kdRatio, avg: "kd_ratio", labelKey: "compare.kdRatio", decimals: 2 },
  { get: (s) => s.pmcKdRatio, avg: "pmc_kd_ratio", labelKey: "metric.pmc_kd_ratio", decimals: 2 },
  { get: (s) => s.survivalRate, avg: "survival_rate", labelKey: "compare.survivalRate", decimals: 1, suffix: "%" },
  { get: (s) => s.killsPerRaid, avg: "kills_per_raid", labelKey: "compare.killsPerRaid", decimals: 2 },
  { get: (s) => s.totalKills, avg: "total_kills", labelKey: "compare.totalKills", decimals: 0 },
  { get: (s) => s.totalRaids, avg: "total_raids", labelKey: "compare.totalRaids", decimals: 0 },
  { get: (s) => s.longestWinStreak, avg: "longest_win_streak", labelKey: "compare.winStreak", decimals: 0 },
  { get: (s) => s.achievementsCount, avg: "achv_count", labelKey: "compare.achievements", decimals: 0 },
  { get: (s) => s.hoursPlayed, avg: "hours", labelKey: "compare.hoursPlayed", decimals: 0 },
  { get: (s) => s.level, avg: "level", labelKey: "compare.level", decimals: 0 },
];

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

  // Same rows for both modes; only the opponent value lookup differs. Skips
  // metrics whose opponent value is unavailable (e.g. an average not yet computed).
  function buildRows(
    opponentValue: (m: (typeof METRICS)[number]) => number | null | undefined
  ): ComparisonRow[] {
    const rows: ComparisonRow[] = [];
    for (const m of METRICS) {
      const valueB = opponentValue(m);
      if (typeof valueB !== "number") continue;
      rows.push({ label: t(m.labelKey), valueA: m.get(stats), valueB, decimals: m.decimals, suffix: m.suffix });
    }
    return rows;
  }

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
              <ComparisonTable
                nameA={stats.nickname}
                nameB={t("compare.avgName")}
                rows={buildRows((m) => avgData.averages[m.avg])}
              />
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

          {/* Quick-pick from the user's favorites */}
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
              rows={buildRows((m) => m.get(otherStats))}
            />
          )}
        </div>
      )}
    </div>
  );
}
