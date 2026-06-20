"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import StatCard from "@/components/StatCard";
import MetricPicker from "@/components/MetricPicker";
import AchievementBreakdown from "@/components/AchievementBreakdown";
import { buildHistogram, type BracketAgg } from "@/lib/histogram";
import { DEFAULT_Y, resolveY, formatValue } from "@/lib/metrics";
import { PLAYTIME_RANGES } from "@/lib/playtime-brackets";

interface AverageRow {
  n: number;
  [metric: string]: number | null;
}
interface AverageResponse {
  total: number;
  averages: AverageRow | null;
  brackets: BracketAgg[];
  metric: string;
}

const RANGES: { label: string; min: number | null; max: number | null }[] = [
  { label: "All hours", min: null, max: null },
  ...PLAYTIME_RANGES,
];

const METRICS: { key: string; label: string; suffix?: string; decimals?: number }[] = [
  { key: "kd_ratio", label: "K/D (all)", decimals: 2 },
  { key: "pmc_kd_ratio", label: "PMC K/D", decimals: 2 },
  { key: "survival_rate", label: "Survival Rate", suffix: "%", decimals: 1 },
  { key: "kills_per_raid", label: "Kills / Raid", decimals: 2 },
  { key: "total_raids", label: "Raids", decimals: 0 },
  { key: "total_kills", label: "Total Kills", decimals: 0 },
  { key: "killed_pmc", label: "PMC Kills", decimals: 0 },
  { key: "deaths", label: "Deaths", decimals: 0 },
  { key: "run_through", label: "Run-throughs", decimals: 1 },
  { key: "longest_win_streak", label: "Win Streak", decimals: 1 },
  { key: "achv_count", label: "Achievements", decimals: 1 },
  { key: "hours", label: "Hours", decimals: 0 },
  { key: "level", label: "Level", decimals: 0 },
  { key: "prestige", label: "Prestige", decimals: 2 },
];

function fmt(v: number | null | undefined, decimals = 1): string {
  if (v == null || Number.isNaN(v)) return "—";
  return v.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export default function AveragePage() {
  const [rangeIdx, setRangeIdx] = useState(0);
  const [yMetric, setYMetric] = useState(DEFAULT_Y);
  const [data, setData] = useState<AverageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showAch, setShowAch] = useState(false);

  function openBreakdown() {
    setShowAch(true);
    // Wait for the panel to mount before scrolling it into view.
    requestAnimationFrame(() =>
      document.getElementById("ach-breakdown")?.scrollIntoView({ behavior: "smooth", block: "start" })
    );
  }

  useEffect(() => {
    const r = RANGES[rangeIdx];
    const params = new URLSearchParams();
    if (r.min != null) params.set("minHours", String(r.min));
    if (r.max != null) params.set("maxHours", String(r.max));
    params.set("metric", yMetric);

    let cancelled = false;
    setLoading(true);
    setError("");
    fetch(`/api/average?${params.toString()}`)
      .then(async (res) => {
        const j = (await res.json()) as AverageResponse & { error?: string };
        if (!res.ok) throw new Error(j.error ?? "Failed to load");
        return j;
      })
      .then((j) => {
        if (!cancelled) setData(j);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [rangeIdx, yMetric]);

  const averages = data?.averages ?? null;
  const sampleN = averages?.n ?? 0;
  const total = data?.total ?? 0;

  // The histogram reflects the metric the data is actually for (data.metric),
  // not the pending selection, so labels never mismatch mid-fetch.
  const yDef = resolveY(data?.metric);
  const isCount = yDef.agg === "count";
  const bins = buildHistogram(data?.brackets ?? []);
  const valueOf = (b: { n: number; sum: number }) => (isCount ? b.n : b.n > 0 ? b.sum / b.n : 0);
  const peak = Math.max(0, ...bins.map(valueOf));
  const maxVal = peak || 1; // avoid /0 when every value is 0; otherwise scale to the real peak

  return (
    <main className="flex-1 px-4 py-8 max-w-5xl mx-auto w-full">
      <div className="flex items-baseline justify-between flex-wrap gap-2 mb-6">
        <h1 className="text-2xl font-bold text-[var(--accent)]">Average Player Statistics</h1>
        <Link href="/" className="text-sm text-gray-500 hover:text-[var(--accent)]">
          &larr; Search by ID
        </Link>
      </div>

      {/* Total scanned accounts */}
      <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-4 mb-6">
        <div className="text-xs uppercase tracking-wider text-gray-500">Accounts scanned</div>
        <div className="text-3xl font-bold text-[var(--foreground)]">
          {total.toLocaleString()}
        </div>
        <p className="text-xs text-gray-600 mt-1">
          The sample grows every time a player is looked up by ID.
        </p>
      </div>

      {/* Hours range selector */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <label className="text-sm text-gray-400">Playtime range:</label>
        <select
          value={rangeIdx}
          onChange={(e) => setRangeIdx(Number(e.target.value))}
          className="px-3 py-2 bg-[var(--input-bg)] border border-[var(--card-border)] rounded text-sm focus:outline-none focus:border-[var(--accent)]"
        >
          {RANGES.map((r, i) => (
            <option key={r.label} value={i}>
              {r.label}
            </option>
          ))}
        </select>
        {data && (
          <span className="text-sm text-gray-500">
            based on <span className="text-[var(--accent)] font-medium">{sampleN.toLocaleString()}</span>{" "}
            account{sampleN === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {error && <p className="text-[var(--danger)] text-sm mb-4">{error}</p>}

      {!data ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="h-20 skeleton rounded-lg" />
          ))}
        </div>
      ) : sampleN === 0 ? (
        <p className="text-gray-500">
          No accounts in this range yet. Look up some players by ID to build the sample.
        </p>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {METRICS.map((m) => {
            const card = (
              <StatCard
                label={`Avg ${m.label}`}
                value={fmt(averages?.[m.key], m.decimals ?? 1)}
                suffix={m.suffix}
              />
            );
            // The achievements card is a shortcut into the hidden breakdown panel.
            if (m.key === "achv_count") {
              return (
                <button
                  key={m.key}
                  onClick={openBreakdown}
                  title="Show achievement breakdown"
                  className="relative text-left rounded-lg transition-shadow hover:ring-1 hover:ring-[var(--accent)]/60 focus:outline-none focus:ring-1 focus:ring-[var(--accent)] group"
                >
                  {card}
                  <span className="absolute top-3 right-3 text-[11px] text-gray-600 group-hover:text-[var(--accent)] transition-colors">
                    ▸
                  </span>
                </button>
              );
            }
            return <div key={m.key}>{card}</div>;
          })}
        </div>
      )}

      {/* Achievement breakdown — drilldown from the "Avg achievements" card above. */}
      <AchievementBreakdown open={showAch} onToggle={() => setShowAch((o) => !o)} />

      {/* Distribution by playtime — pick what the bar height measures */}
      <h2 className="text-sm uppercase tracking-wider text-gray-500 mt-10 mb-1">
        Distribution by playtime
      </h2>
      <p className="text-xs text-gray-600 mb-4">
        The bottom axis is always playtime. Pick a stat on the left to change what
        the bar height shows — player count, or that stat averaged over each
        playtime range. Ranges stay wide where the sample is thin and split toward
        50&nbsp;h steps as more accounts are collected.
      </p>

      <div className="flex flex-col sm:flex-row gap-4">
        {/* Y-axis metric picker */}
        <MetricPicker value={yMetric} onChange={setYMetric} />

        {/* Chart */}
        <div className="flex-1 min-w-0 bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-4">
          <div className="text-[11px] text-gray-500 mb-2">
            <span className="text-[var(--accent)] font-medium">{yDef.label}</span> by playtime
          </div>
          {!data ? (
            <div className="h-52 skeleton rounded" />
          ) : bins.length === 0 ? (
            <p className="text-gray-600 text-sm">No data yet.</p>
          ) : (
            <div className={`overflow-x-auto ${loading ? "opacity-60" : ""} transition-opacity`}>
              <div className="flex items-end gap-1.5 h-52 border-b border-[var(--card-border)]">
                {bins.map((b) => {
                  const v = valueOf(b);
                  return (
                    <div
                      key={b.lo}
                      className="flex-1 min-w-[26px] h-full flex flex-col items-center justify-end"
                      title={
                        isCount
                          ? `${b.label} h · ${b.n.toLocaleString()} player${b.n === 1 ? "" : "s"}`
                          : `${b.label} h · ${formatValue(yDef, v)} avg · ${b.n.toLocaleString()} player${b.n === 1 ? "" : "s"}`
                      }
                    >
                      <span className="text-[10px] leading-none text-gray-400 mb-1">
                        {formatValue(yDef, v)}
                      </span>
                      <div
                        className="w-full bg-[var(--accent)]/60 hover:bg-[var(--accent)] rounded-t transition-colors"
                        style={{ height: `${(v / maxVal) * 88}%`, minHeight: 2 }}
                      />
                    </div>
                  );
                })}
              </div>
              <div className="flex gap-1.5 mt-2">
                {bins.map((b) => (
                  <span
                    key={b.lo}
                    className="flex-1 min-w-[26px] text-[9px] leading-tight text-gray-500 text-center"
                  >
                    {b.label}
                  </span>
                ))}
              </div>
              <div className="text-[10px] text-gray-600 text-center mt-2">hours played</div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
