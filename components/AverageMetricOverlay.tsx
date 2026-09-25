"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { loadAverageJson } from "@/lib/client-average-request";
import { useI18n } from "@/lib/i18n/context";

interface OverlayBucket {
  lo: number;
  hi: number | null;
  n: number;
  sum: number;
}

interface OverlayResponse {
  buckets?: OverlayBucket[];
  bounds?: { min: number; max: number };
}

const OVERLAY_METRICS = [
  { key: "kd_ratio", digits: 2, color: "#9ec49f" },
  { key: "survival_rate", digits: 1, color: "#58a6ff" },
  { key: "kills_per_raid", digits: 2, color: "#ffb74d" },
  { key: "total_kills", digits: 0, color: "#e06c75" },
  { key: "deaths", digits: 0, color: "#56b6c2" },
  { key: "total_raids", digits: 0, color: "#9aa0a6" },
] as const;

const WIDTH = 760;
const HEIGHT = 260;
const PAD = { top: 14, right: 14, bottom: 34, left: 44 };

export default function AverageMetricOverlay({
  mode = "regular",
  cycleId = "persistent",
}: {
  mode?: "regular" | "pve" | "seasonal";
  cycleId?: string;
}) {
  const { t, lang } = useI18n();
  const searchParams = useSearchParams();
  const statistic = searchParams.get("statistic") === "median" ? "median" : "trimmed_mean";
  const period = mode === "regular" && searchParams.get("period") === "90d" ? "90d" : "all";
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(OVERLAY_METRICS.map((metric) => [metric.key, true])),
  );
  const [series, setSeries] = useState<Record<string, { avg: number[]; lo: number[]; max: number }>>({});
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setSeries({});
    setFailed(false);
    const endpoint = mode === "seasonal" ? "/api/seasonal/average" : "/api/average";
    void Promise.all(
      OVERLAY_METRICS.map(async (metric) => {
        const params = new URLSearchParams({ dimension: "pmc_raids", metric: metric.key, statistic, period });
        if (mode !== "seasonal") params.set("mode", mode);
        if (mode === "seasonal" && cycleId) params.set("cycle", cycleId);
        try {
          const json = await loadAverageJson<OverlayResponse>(`${endpoint}?${params.toString()}`, {
            signal: controller.signal,
            retryUnavailable: true,
          });
          if (controller.signal.aborted) return;
          const buckets = json.buckets ?? [];
          const avg = buckets.map((bucket) => (bucket.n > 0 ? bucket.sum / bucket.n : 0));
          const lo = buckets.map((bucket) => bucket.lo);
          setSeries((current) => ({
            ...current,
            [metric.key]: { avg, lo, max: Math.max(0, ...avg) },
          }));
        } catch (caught: unknown) {
          if (caught instanceof Error && caught.name === "AbortError") return;
          if (!controller.signal.aborted) setFailed(true);
        }
      }),
    );
    return () => controller.abort();
  }, [cycleId, mode, period, statistic]);

  const active = OVERLAY_METRICS.filter((metric) => enabled[metric.key] && series[metric.key]);
  const xDomain = (() => {
    const los = active.flatMap((metric) => series[metric.key].lo);
    if (los.length === 0) return { min: 0, max: 1000 };
    return { min: Math.min(...los), max: Math.max(...los, 1) };
  })();
  const x = (lo: number) =>
    PAD.left + ((lo - xDomain.min) / Math.max(1, xDomain.max - xDomain.min)) * (WIDTH - PAD.left - PAD.right);
  const y = (fraction: number) => PAD.top + (1 - fraction) * (HEIGHT - PAD.top - PAD.bottom);
  const line = (values: number[], los: number[], max: number) =>
    values
      .map((value, index) => `${index === 0 ? "M" : "L"}${x(los[index]).toFixed(1)},${y(max > 0 ? value / max : 0).toFixed(1)}`)
      .join(" ");
  const fmtMax = (key: string, max: number) => {
    const digits = OVERLAY_METRICS.find((metric) => metric.key === key)?.digits ?? 1;
    return max.toLocaleString(lang, { maximumFractionDigits: digits });
  };

  return (
    <section className="data-panel seasonal-chart mt-4" aria-label={t("average.metricChart")}>
      <div className="seasonal-chart__head">
        <h2 className="section-heading">{t("average.metricChart")}</h2>
        <div className="seasonal-chart__toggles" aria-label={t("average.metricChart")}>
          {OVERLAY_METRICS.map((metric) => (
            <button
              type="button"
              key={metric.key}
              aria-pressed={enabled[metric.key]}
              onClick={() => setEnabled((current) => ({ ...current, [metric.key]: !current[metric.key] }))}
              className={enabled[metric.key] ? "is-active" : ""}
            >
              <span style={{ background: metric.color }} aria-hidden="true" />
              {t("metric." + metric.key)}
            </button>
          ))}
        </div>
      </div>
      {failed && active.length === 0 ? (
        <p className="seasonal-chart__empty">{t("common.loadFailed")}</p>
      ) : (
        <div className="seasonal-chart__scroll">
          <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={t("average.metricChart")}>
            {[0, 0.5, 1].map((tick) => (
              <line
                key={tick}
                x1={PAD.left}
                x2={WIDTH - PAD.right}
                y1={y(tick)}
                y2={y(tick)}
                className="seasonal-chart__grid"
              />
            ))}
            {active.map((metric) => {
              const data = series[metric.key];
              return (
                <path
                  key={metric.key}
                  d={line(data.avg, data.lo, data.max)}
                  fill="none"
                  stroke={metric.color}
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
            <text x={PAD.left + (WIDTH - PAD.left - PAD.right) / 2} y={HEIGHT - 6} textAnchor="middle" className="seasonal-chart__axis">
              {t("average.pmcRaidsPlayed")}
            </text>
          </svg>
        </div>
      )}
      <div className="seasonal-chart__meta">
        {active.map((metric) => (
          <span key={metric.key}>
            <i aria-hidden="true" style={{ display: "inline-block", width: 10, height: 4, background: metric.color, marginRight: 6 }} />
            {t("metric." + metric.key)} · max {fmtMax(metric.key, series[metric.key].max)}
          </span>
        ))}
      </div>
      <p className="arena-combat-footnote">{t("average.metricChartNorm")}</p>
    </section>
  );
}
