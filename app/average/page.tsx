"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import StatCard from "@/components/StatCard";
import MetricPicker from "@/components/MetricPicker";
import AchievementBreakdown from "@/components/AchievementBreakdown";
import { MAX_HISTOGRAM_BINS, type HistBin } from "@/lib/histogram";
import { DEFAULT_Y, resolveY, formatValue } from "@/lib/metrics";
import { PLAYTIME_RANGES } from "@/lib/playtime-brackets";

interface AverageRow {
  n: number;
  [metric: string]: number | null;
}
interface AverageResponse {
  total: number;
  averages: AverageRow | null;
  histogram: HistBin[];
  metric: string;
}

const RANGES: { label: string; min: number | null; max: number | null }[] = [
  { label: "All hours", min: null, max: null },
  ...PLAYTIME_RANGES,
];

const METRICS: { key: string; suffix?: string; decimals?: number }[] = [
  { key: "kd_ratio", decimals: 2 },
  { key: "pmc_kd_ratio", decimals: 2 },
  { key: "survival_rate", suffix: "%", decimals: 1 },
  { key: "kills_per_raid", decimals: 2 },
  { key: "total_raids", decimals: 0 },
  { key: "total_kills", decimals: 0 },
  { key: "killed_pmc", decimals: 0 },
  { key: "deaths", decimals: 0 },
  { key: "run_through", decimals: 1 },
  { key: "longest_win_streak", decimals: 1 },
  { key: "achv_count", decimals: 1 },
  { key: "hours", decimals: 0 },
  { key: "level", decimals: 0 },
  { key: "prestige", decimals: 2 },
];

// Bar geometry, kept in sync with the chart's `min-w-[26px]` floor and the
// `gap-1.5` (6px) column gap below. Used to pick how many bars fit the measured
// chart width so the histogram pools to fit instead of overflowing into a
// horizontal scrollbar.
const BAR_MIN_PX = 26;
const BAR_GAP_PX = 6;

function fmt(v: number | null | undefined, decimals = 1): string {
  if (v == null || Number.isNaN(v)) return "—";
  return v.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export default function AveragePage() {
  const { t } = useI18n();
  const [rangeIdx, setRangeIdx] = useState(0);
  const [yMetric, setYMetric] = useState(DEFAULT_Y);
  const [data, setData] = useState<AverageResponse | null>(null);
  const [settledRequest, setSettledRequest] = useState("");
  const [error, setError] = useState("");
  const [showAch, setShowAch] = useState(false);
  // Measured content width of the chart card, so we can pool the histogram down
  // to however many bars actually fit instead of spilling into a scrollbar.
  const chartRef = useRef<HTMLDivElement>(null);
  const [chartW, setChartW] = useState(0);

  useEffect(() => {
    const el = chartRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      // contentRect.width is the box inside the card's padding — exactly the
      // room the bars get.
      setChartW(entries[0].contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // N bars need N*BAR + (N-1)*GAP px. The API uses this budget to form the
  // final bins before calculating their trimmed averages.
  const fitBins =
    chartW > 0
      ? Math.min(
          MAX_HISTOGRAM_BINS,
          Math.max(1, Math.floor((chartW + BAR_GAP_PX) / (BAR_MIN_PX + BAR_GAP_PX)))
        )
      : MAX_HISTOGRAM_BINS;
  const requestKey = `${rangeIdx}:${yMetric}:${fitBins}`;
  const loading = settledRequest !== requestKey;

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
    params.set("maxBins", String(fitBins));

    let cancelled = false;
    fetch(`/api/average?${params.toString()}`)
      .then(async (res) => {
        const j = (await res.json()) as AverageResponse & { error?: string };
        if (!res.ok) throw new Error(j.error ?? t("common.loadFailed"));
        return j;
      })
      .then((j) => {
        if (!cancelled) {
          setData(j);
          setError("");
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : t("common.loadFailed"));
      })
      .finally(() => {
        if (!cancelled) setSettledRequest(requestKey);
      });

    return () => {
      cancelled = true;
    };
  }, [rangeIdx, yMetric, fitBins, requestKey, t]);

  const averages = data?.averages ?? null;
  const sampleN = averages?.n ?? 0;
  const total = data?.total ?? 0;

  // The histogram reflects the metric the data is actually for (data.metric),
  // not the pending selection, so labels never mismatch mid-fetch.
  const yDef = resolveY(data?.metric);
  const isCount = yDef.agg === "count";
  const bins = data?.histogram ?? [];
  const valueOf = (b: HistBin) => (isCount ? b.n : b.avg ?? 0);
  const peak = Math.max(0, ...bins.map(valueOf));
  const maxVal = peak || 1; // avoid /0 when every value is 0; otherwise scale to the real peak
  const focusMetrics = METRICS.slice(0, 4);
  const detailMetrics = METRICS.slice(4);

  function renderMetric(m: (typeof METRICS)[number]) {
    const card = (
      <StatCard
        label={`${t("common.avg")} ${t("metric." + m.key)}`}
        value={fmt(averages?.[m.key], m.decimals ?? 1)}
        suffix={m.suffix}
      />
    );

    if (m.key !== "achv_count") return <div key={m.key}>{card}</div>;

    return (
      <button
        key={m.key}
        onClick={openBreakdown}
        title={t("average.showAchBreakdown")}
        className="relative text-left rounded-[10px] transition-transform hover:-translate-y-0.5 focus:outline-none"
      >
        {card}
        <span className="absolute right-4 top-4 text-xs text-[var(--accent)]" aria-hidden>↗</span>
      </button>
    );
  }

  return (
    <main className="page-frame">
      <Link
        href="/"
        className="text-sm text-[var(--muted)] hover:text-[var(--foreground)] transition-colors inline-block"
      >
        {t("common.back")}
      </Link>
      <p className="page-kicker mt-7">{t("average.summary")}</p>
      <h1 className="page-title">{t("nav.average")}</h1>

      <section className="summary-strip surface">
        <div className="summary-strip__copy">
          <div className="section-kicker">{t("average.accountsScanned")}</div>
          <div className="summary-strip__number">{total.toLocaleString()}</div>
          <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]">{t("average.sampleGrows")}</p>
        </div>
        <div className="flex flex-col gap-2 sm:items-end">
          <label className="section-kicker" htmlFor="playtime-range">{t("average.playtimeRange")}</label>
          <select
            id="playtime-range"
            value={rangeIdx}
            onChange={(e) => setRangeIdx(Number(e.target.value))}
            className="min-h-12 rounded-full border border-[var(--card-border)] bg-[var(--input-bg)] px-4 text-sm text-[var(--foreground)] focus:outline-none focus:border-[var(--accent)]"
          >
            {RANGES.map((r, i) => (
              <option key={r.label} value={i}>
                {r.min == null && r.max == null ? t("range.all") : `${r.label} ${t("unit.h")}`}
              </option>
            ))}
          </select>
          {data && <span className="text-xs text-[var(--muted)]">{t("average.basedOn", { n: sampleN.toLocaleString() })}</span>}
        </div>
      </section>

      {error && !loading && <p className="text-[var(--danger)] text-sm mt-5">{error}</p>}

      {!data ? (
        <div className="detail-grid mt-5">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="h-28 skeleton rounded-xl" />
          ))}
        </div>
      ) : sampleN === 0 ? (
        <p className="mt-5 text-[var(--muted)]">
          {t("average.emptyRange")}
        </p>
      ) : (
        <>
          <section className="mt-5">
            <h2 className="section-heading mb-3">{t("average.summary")}</h2>
            <div className="detail-grid">{focusMetrics.map(renderMetric)}</div>
            <p className="mt-3 text-xs leading-relaxed text-[var(--muted)]">{t("average.robustNote")}</p>
          </section>

          <section className="mt-10">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="section-heading">{t("average.distributionHeading")}</h2>
                <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">{t("average.distributionDesc")}</p>
              </div>
              <MetricPicker value={yMetric} onChange={setYMetric} />
            </div>

            <div ref={chartRef} className="chart-panel data-panel">
              <div className="text-xs text-[var(--muted)] mb-4">
                <span className="text-[var(--accent)] font-semibold">
                  {yDef.agg === "avg" ? `${t("common.avg")} ${t("metric." + yDef.key)}` : t("metric." + yDef.key)}
                </span>{" "}
                {t("average.byPlaytime")}
              </div>
              {bins.length === 0 ? (
                <p className="text-[var(--muted)] text-sm">{t("average.noDataYet")}</p>
              ) : (
                <div className={`overflow-x-auto ${loading ? "opacity-60" : ""} transition-opacity`}>
                  <div className="flex items-end gap-1.5 h-60 border-b border-[var(--card-border)]">
                    {bins.map((b) => {
                      const v = valueOf(b);
                      return (
                        <div
                          key={b.lo}
                          className="flex-1 min-w-[26px] h-full flex flex-col items-center justify-end"
                          title={
                            isCount
                              ? t("average.barTipCount", { label: b.label, n: b.n.toLocaleString() })
                              : t("average.barTipAvg", { label: b.label, avg: formatValue(yDef, v), n: b.n.toLocaleString() })
                          }
                        >
                          <span className="text-[10px] leading-none text-[var(--muted)] mb-2">{formatValue(yDef, v)}</span>
                          <div
                            className="w-full bg-[var(--accent)]/65 hover:bg-[var(--accent)] rounded-t transition-colors"
                            style={{ height: `${(v / maxVal) * 88}%`, minHeight: 2 }}
                          />
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex gap-1.5 mt-3">
                    {bins.map((b) => (
                      <span key={b.lo} className="flex-1 min-w-[26px] text-[9px] leading-tight text-[var(--muted)] text-center">{b.label}</span>
                    ))}
                  </div>
                  <div className="text-[10px] text-[var(--muted)] text-center mt-3">{t("average.hoursPlayed")}</div>
                </div>
              )}
            </div>
          </section>

          <section className="mt-10">
            <h2 className="section-heading mb-3">{t("average.fullMetrics")}</h2>
            <div className="detail-grid detail-grid--compact">{detailMetrics.map(renderMetric)}</div>
          </section>

          <AchievementBreakdown open={showAch} onToggle={() => setShowAch((o) => !o)} />
        </>
      )}
    </main>
  );
}
