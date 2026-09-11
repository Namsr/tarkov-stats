"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { homePercentageDifference, homeRadarRatio } from "@/lib/home-showcase";
import { useChartWidth } from "@/components/home/useChartWidth";

export interface ProfileRadarMetric {
  key: string;
  label: string;
  shortLabel?: string;
  a: number | null;
  b: number | null;
  baseline: number | null;
  digits: number;
  percent?: boolean;
}

export default function ProfileRadar({ metrics, playerName, otherName }: {
  metrics: readonly ProfileRadarMetric[]; playerName: string; otherName: string;
}) {
  const { t, lang } = useI18n();
  const [table, setTable] = useState(false);
  const [active, setActive] = useState<{ index: number; x: number; y: number } | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const { ref, width } = useChartWidth(600);
  const mobile = width < 450, height = mobile ? 330 : 360;
  const radius = Math.min(mobile ? 105 : 132, (width - 90) / 2.3, height / 2 - 66);
  const angles = metrics.length === 5 ? [-90, -18, 54, 126, 198] : [-150, -90, -30, 30, 90, 150];
  const point = (index: number, r: number) => ({ x: width / 2 + Math.cos(angles[index] * Math.PI / 180) * r, y: height / 2 + Math.sin(angles[index] * Math.PI / 180) * r });
  const polygon = (points: { x: number; y: number }[]) => points.map((p) => `${p.x},${p.y}`).join(" ");
  const value = (v: number | null, metric: ProfileRadarMetric) => v == null || !Number.isFinite(v) ? "—" : v.toLocaleString(lang, { minimumFractionDigits: metric.digits, maximumFractionDigits: metric.digits }) + (metric.percent ? "%" : "");
  const difference = (metric: ProfileRadarMetric) => {
    const d = homePercentageDifference(metric.a, metric.b);
    return d == null ? "—" : `${d > 0 ? "+" : d < 0 ? "−" : ""}${Math.abs(d).toLocaleString(lang, { maximumFractionDigits: 1 })}%`;
  };
  useLayoutEffect(() => {
    const tip = tooltipRef.current;
    if (!active || !tip) return;
    const { width: w, height: h } = tip.getBoundingClientRect();
    const left = active.x + 14 + w > width - 8 ? active.x - w - 14 : active.x + 14;
    const top = active.y + 14 + h > height - 8 ? active.y - h - 14 : active.y + 14;
    tip.style.left = `${Math.max(8, Math.min(left, width - w - 8))}px`;
    tip.style.top = `${Math.max(8, Math.min(top, height - h - 8))}px`;
  }, [active, width, height, lang]);

  function show(index: number, p: { x: number; y: number }, event?: { clientX: number; clientY: number; currentTarget: SVGCircleElement }) {
    const rect = event?.currentTarget.ownerSVGElement?.getBoundingClientRect();
    setActive({ index, x: event && rect ? event.clientX - rect.left : p.x, y: event && rect ? event.clientY - rect.top : p.y });
  }
  const selected = active ? metrics[active.index] : null;
  const comparisonTable = <table className="profile-comparison-table">
    <caption className="sr-only">{t("radar.title")}</caption>
    <thead><tr><th scope="col">{t("home.metric")}</th><th scope="col">{playerName}</th><th scope="col">{otherName}</th><th scope="col">{t("profile.difference")}</th></tr></thead>
    <tbody>{metrics.map((metric) => <tr key={metric.key}><th scope="row">{metric.label}</th><td>{value(metric.a, metric)}</td><td>{value(metric.b, metric)}</td><td>{difference(metric)}</td></tr>)}</tbody>
  </table>;

  return <>
    <div className="profile-comparison-display">
      <div className="profile-chart-legend"><span><i aria-hidden="true" />{playerName}</span><span><i className="is-other" aria-hidden="true" />{otherName}</span></div>
      <div className="profile-segments" role="group" aria-label={t("profile.comparisonView")}>
        <button type="button" aria-pressed={!table} onClick={() => { setTable(false); setActive(null); }}>{t("profile.graph")}</button>
        <button type="button" aria-pressed={table} onClick={() => { setTable(true); setActive(null); }}>{t("profile.table")}</button>
      </div>
    </div>
    <div ref={ref} className="profile-radar" style={table ? undefined : { minHeight: height }}>
      {table ? comparisonTable : <>
        <svg viewBox={`0 0 ${width} ${height}`} role="group" aria-label={t("radar.title")}>
          {[.25, .5, .75, 1].map((ratio) => <polygon key={ratio} points={polygon(metrics.map((_, i) => point(i, radius * ratio)))} fill="none" stroke="var(--card-border)" />)}
          {metrics.map((metric, i) => { const p = point(i, radius); return <line key={metric.key} x1={width / 2} y1={height / 2} x2={p.x} y2={p.y} stroke="var(--card-border)" />; })}
          {(["b", "a"] as const).map((series) => {
            const points = metrics.map((metric, i) => { const ratio = homeRadarRatio(metric[series], metric.baseline); return ratio == null ? null : point(i, ratio * radius); });
            const color = series === "a" ? "var(--foreground)" : "var(--profile-other)";
            return <g key={series}>
              {points.every((p) => p != null) && <polygon data-series={series} points={polygon(points)} fill={series === "a" ? color : "none"} fillOpacity=".055" stroke={color} strokeWidth="2.5" strokeDasharray={series === "b" ? "7 6" : undefined} />}
              {points.map((p, i) => p && (series === "a" ? <circle key={i} cx={p.x} cy={p.y} r="4" fill={color} /> : <rect key={i} x={p.x - 3.5} y={p.y - 3.5} width="7" height="7" fill={color} />))}
            </g>;
          })}
          {metrics.map((metric, i) => {
            const p = point(i, radius + 45), right = p.x > width / 2 + 10, left = p.x < width / 2 - 10;
            const x = mobile && right ? width - 4 : mobile && left ? 4 : p.x;
            return <text key={metric.key} x={x} y={p.y} textAnchor={mobile && right ? "end" : mobile && left ? "start" : "middle"} className="profile-radar-label">
              {(metric.shortLabel ?? metric.label).split("|").map((line, row) => <tspan key={row} x={x} dy={row ? 16 : 0}>{line}</tspan>)}
            </text>;
          })}
          {metrics.flatMap((metric, i) => (["b", "a"] as const).map((series) => {
            const ratio = homeRadarRatio(metric[series], metric.baseline);
            if (ratio == null) return null;
            const p = point(i, ratio * radius);
            return <circle key={`${metric.key}-${series}`} className="profile-radar-hit" data-series={series} data-metric={metric.key} cx={p.x} cy={p.y} r="16" fill="transparent" role="button" tabIndex={series === "a" ? 0 : -1}
              aria-label={`${metric.label}: ${playerName} ${value(metric.a, metric)}, ${otherName} ${value(metric.b, metric)}. ${t("profile.difference")}: ${difference(metric)}`}
              onPointerEnter={(event) => show(i, p, event)} onPointerMove={(event) => show(i, p, event)} onPointerLeave={(event) => { if (!event.currentTarget.matches(":focus-visible")) setActive(null); }}
              onFocus={() => show(i, p)} onBlur={() => setActive(null)} onClick={(event) => show(i, p, event)}
              onKeyDown={(event) => { if (event.key === "Escape") setActive(null); if (event.key === "Enter" || event.key === " ") { event.preventDefault(); show(i, p); } }} />;
          }))}
        </svg>
        {active && selected && <div ref={tooltipRef} className="profile-chart-tooltip" role="status"><strong>{selected.label}</strong>
          <div><span>{playerName}</span><b>{value(selected.a, selected)}</b></div><div><span>{otherName}</span><b>{value(selected.b, selected)}</b></div>
          <div className="profile-chart-tooltip__difference"><span>{t("profile.difference")}</span><b>{difference(selected)}</b></div>
          {selected.b === 0 && selected.a !== 0 && <p>{t("home.noPercentage")}</p>}
        </div>}
        <div className="sr-only">{comparisonTable}</div>
      </>}
    </div>
    {metrics.some((metric) => metric.baseline == null) && <p className="profile-chart-notice">{t("radar.baselineUnavailable")}</p>}
  </>;
}
