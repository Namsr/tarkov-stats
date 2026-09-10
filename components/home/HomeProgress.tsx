"use client";

import { useId, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { homeProgressPoints, type HomeProgressMetric } from "@/lib/home-showcase";
import type { ProgressionTimelineResponse } from "@/types/seasonal";
import { useChartWidth } from "./useChartWidth";

export default function HomeProgress({ timeline, name }: { timeline: ProgressionTimelineResponse | null | undefined; name: string }) {
  const { t, lang } = useI18n();
  const [metric, setMetric] = useState<HomeProgressMetric>("level");
  const [active, setActive] = useState<number | null>(null);
  const [pinned, setPinned] = useState(false);
  const { ref, width } = useChartWidth(1120);
  const gradientId = useId();
  const tipId = useId();
  const points = timeline ? homeProgressPoints(timeline, metric) : [];
  const first = points[0], last = points.at(-1);
  const height = width < 500 ? 230 : 265, left = width < 500 ? 38 : 48, right = 14, bottom = 31;
  const values = points.map((point) => point.value);
  const min = Math.min(...values), max = Math.max(...values), range = Math.max(max - min, 1);
  const minX = first?.raids ?? 0, maxX = last?.raids ?? 1;
  const x = (value: number) => left + (value - minX) / Math.max(maxX - minX, 1) * (width - left - right);
  const y = (value: number) => height - bottom - (value - min + range * .18) / (range * 1.36) * (height - 20 - bottom);
  const digits = metric === "level" ? 0 : metric === "pvp_kd" ? 2 : 1;
  const n = (value: number, precision = digits) => value.toLocaleString(lang, { maximumFractionDigits: precision });
  const date = (value: number | null) => value == null ? "—" : new Date(value).toLocaleDateString(lang, { day: "numeric", month: "short", timeZone: "Europe/Moscow" });
  const format = (value: number) => n(value) + (metric === "survival" ? "%" : "");
  const d = points.map((point, index) => `${index ? "L" : "M"}${x(point.raids)},${y(point.value)}`).join(" ");
  const levelTickCount = Math.min(5, max - min + 1);
  const ticks = !first ? [] : metric === "level"
    ? Array.from({ length: levelTickCount }, (_, index) => Math.round(min + (max - min) * index / Math.max(1, levelTickCount - 1)))
    : Array.from({ length: 4 }, (_, index) => min + range * index / 3);
  const xTickCount = minX === maxX ? 1 : width < 500 ? 3 : 5;
  const current = active == null ? null : points[active];
  const delta = first && last ? last.value - first.value : 0;
  function inspect(clientX: number, svg: SVGSVGElement) {
    const px = (clientX - svg.getBoundingClientRect().left);
    let nearest = 0;
    points.forEach((point, index) => { if (Math.abs(x(point.raids) - px) < Math.abs(x(points[nearest].raids) - px)) nearest = index; });
    if (points.length) setActive(nearest);
  }

  return <>
    <div className="home-progress-controls">
      <div className="home-segments" role="group" aria-label={t("home.chartMetric")}>
        {([ ["level", "metric.level"], ["pvp_kd", "metric.pmc_kd_ratio"], ["survival", "metric.survival_rate"] ] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={metric === key} onClick={() => { setMetric(key); setActive(null); setPinned(false); }}>{t(label)}</button>)}
      </div><span className="home-context-name">{name}</span>
    </div>
    {first && last && <div className="home-progress-summary"><div><strong>{format(last.value)}</strong><span className={delta < 0 ? "home-negative" : "home-positive"}>{delta >= 0 ? "+" : ""}{n(delta)}{metric === "survival" ? ` ${t("home.percentPoints")}` : ""}</span></div><p>{date(first.at)} – {date(last.at)}</p></div>}
    <div className="home-chart-container" ref={ref}>
      {!first ? <p className="home-empty" role="status">{t(timeline === undefined ? "common.loading" : timeline === null ? "progression.unavailable" : "progression.noHistory")}</p> : <>
        <svg viewBox={`0 0 ${width} ${height}`} role="group" tabIndex={0} aria-label={t("home.chartAlt", { name })} aria-describedby={tipId}
          onPointerMove={(event) => { if (!pinned && event.pointerType !== "touch") inspect(event.clientX, event.currentTarget); }}
          onPointerLeave={() => { if (!pinned) setActive(null); }}
          onClick={(event) => { inspect(event.clientX, event.currentTarget); setPinned(!pinned); }}
          onFocus={() => setActive(points.length - 1)} onBlur={() => { setActive(null); setPinned(false); }}
          onKeyDown={(event) => { if (event.key === "Escape") { setActive(null); setPinned(false); } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setActive(Math.max(0, Math.min(points.length - 1, (active ?? points.length - 1) + (event.key === "ArrowLeft" ? -1 : 1)))); } }}>
          <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--foreground)" stopOpacity=".12" /><stop offset="1" stopColor="var(--foreground)" stopOpacity="0" /></linearGradient></defs>
          {ticks.map((value) => <g key={value} aria-hidden="true"><line x1={left} y1={y(value)} x2={width - right} y2={y(value)} className="home-chart-grid" /><text x={left - 10} y={y(value) + 5} textAnchor="end">{n(value, metric === "level" ? 0 : 1)}</text></g>)}
          {Array.from({ length: xTickCount }, (_, index) => { const value = minX + (maxX - minX) * index / Math.max(1, xTickCount - 1); return <text key={index} x={x(value)} y={height - 4} textAnchor={index === 0 ? "start" : index === xTickCount - 1 ? "end" : "middle"} aria-hidden="true">{n(value, 0)}</text>; })}
          <path d={`${d} L${x(maxX)},${height - bottom} L${x(minX)},${height - bottom} Z`} fill={`url(#${gradientId})`} />
          <path d={d} className="home-chart-line" />
          {points.filter((_, index) => index === 0 || index === points.length - 1 || (width > 600 && index % 3 === 0)).map((point, index) => <circle key={index} cx={x(point.raids)} cy={y(point.value)} r={3.5} className="home-chart-point" />)}
          {current && <g aria-hidden="true"><line x1={x(current.raids)} x2={x(current.raids)} y1={20} y2={height - bottom} stroke="var(--muted)" strokeDasharray="3 5" /><circle cx={x(current.raids)} cy={y(current.value)} r={5} fill="var(--foreground)" /></g>}
        </svg>
        <div id={tipId} className="home-chart-tooltip" role="status" hidden={!current} style={current ? { left: Math.max(4, Math.min(x(current.raids) + 14, width - 255)), top: Math.max(0, y(current.value) - 62) } : undefined}>{current && <>{date(current.at)}<br />{format(current.value)} · {t("home.pointRaids", { n: n(current.raids, 0) })}</>}</div>
      </>}
    </div>
    <div className="home-chart-foot">{t("metric.pmc_raids")}</div>
  </>;
}
