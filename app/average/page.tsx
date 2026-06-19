"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import StatCard from "@/components/StatCard";

interface AverageRow {
  n: number;
  [metric: string]: number | null;
}
interface BracketCount {
  bracket_key: string;
  n: number;
}
interface AverageResponse {
  total: number;
  averages: AverageRow | null;
  brackets: BracketCount[];
}

const RANGES: { label: string; min: number | null; max: number | null }[] = [
  { label: "All hours", min: null, max: null },
  { label: "0–50 h", min: 0, max: 50 },
  { label: "50–100 h", min: 50, max: 100 },
  { label: "100–200 h", min: 100, max: 200 },
  { label: "200–500 h", min: 200, max: 500 },
  { label: "500–1000 h", min: 500, max: 1000 },
  { label: "1000–2000 h", min: 1000, max: 2000 },
  { label: "2000–5000 h", min: 2000, max: 5000 },
  { label: "5000+ h", min: 5000, max: null },
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
  const [data, setData] = useState<AverageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const r = RANGES[rangeIdx];
    const params = new URLSearchParams();
    if (r.min != null) params.set("minHours", String(r.min));
    if (r.max != null) params.set("maxHours", String(r.max));
    const qs = params.toString();

    let cancelled = false;
    setLoading(true);
    setError("");
    fetch(`/api/average${qs ? `?${qs}` : ""}`)
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
  }, [rangeIdx]);

  const averages = data?.averages ?? null;
  const sampleN = averages?.n ?? 0;
  const total = data?.total ?? 0;
  const maxBracket = Math.max(1, ...(data?.brackets ?? []).map((b) => b.n));

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
        {!loading && (
          <span className="text-sm text-gray-500">
            based on <span className="text-[var(--accent)] font-medium">{sampleN.toLocaleString()}</span>{" "}
            account{sampleN === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {error && <p className="text-[var(--danger)] text-sm mb-4">{error}</p>}

      {loading ? (
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
          {METRICS.map((m) => (
            <StatCard
              key={m.key}
              label={`Avg ${m.label}`}
              value={fmt(averages?.[m.key], m.decimals ?? 1)}
              suffix={m.suffix}
            />
          ))}
        </div>
      )}

      {/* Per-bracket sample distribution */}
      <h2 className="text-sm uppercase tracking-wider text-gray-500 mt-10 mb-3">
        Sample size per 50h bracket
      </h2>
      {(data?.brackets ?? []).length === 0 ? (
        <p className="text-gray-600 text-sm">No data yet.</p>
      ) : (
        <div className="space-y-1.5">
          {data!.brackets.map((b) => (
            <div key={b.bracket_key} className="flex items-center gap-3 text-sm">
              <span className="w-28 shrink-0 text-gray-400">{b.bracket_key} h</span>
              <div className="flex-1 bg-[var(--input-bg)] rounded h-4 overflow-hidden">
                <div
                  className="h-full bg-[var(--accent)]/60"
                  style={{ width: `${(b.n / maxBracket) * 100}%` }}
                />
              </div>
              <span className="w-12 shrink-0 text-right text-[var(--foreground)]">{b.n}</span>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
