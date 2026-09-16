"use client";

import { useId, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import ChartCrosshair from "@/components/ChartCrosshair";
import { chartPointAtPointer } from "@/lib/chart-interaction";
import { homeProgressPoints, type HomeProgressMetric } from "@/lib/home-showcase";
import type { ProgressionTimelineResponse } from "@/types/seasonal";
import { useChartWidth } from "./useChartWidth";

export default function HomeProgress({ timeline, name }: { timeline: ProgressionTimelineResponse | null | undefined; name: string }) {
  const { t, lang } = useI18n();
  const [metric, setMetric] = useState<HomeProgressMetric>("level");
  const [active, setActive] = useState<number | null>(null);
  const [shown, setShown] = useState<number | null>(null);
  const { ref, width } = useChartWidth(1120);
  const gradientId = useId();
  const statusId = useId();
  const points = timeline ? homeProgressPoints(timeline, metric) : [];
  const first = points[0], last = points.at(-1);
  const height = width < 500 ? 230 : 265, left = metric === "survival" ? 72 : 58, right = 14, bottom = 31;
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
  const xTickValues = Array.from({ length: xTickCount }, (_, index) => minX + (maxX - minX) * index / Math.max(1, xTickCount - 1));
  const current = active == null ? null : points[active] ?? null;
  const displayed = shown == null ? null : points[shown] ?? null;
  const delta = first && last ? last.value - first.value : 0;

  function show(index: number) {
    setActive(index);
    setShown(index);
  }
  const inspect = (event: { currentTarget: SVGSVGElement; clientX: number; clientY: number }) => {
    const index = chartPointAtPointer(points.map((point) => ({ x: x(point.raids), y: y(point.value) })), event);
    if (index == null) setActive(null); else show(index);
  };

  return <>
    <div className="home-progress-controls">
      <div className="home-segments" role="group" aria-label={t("home.chartMetric")}>
        {([ ["level", "metric.level"], ["pvp_kd", "metric.pmc_kd_ratio"], ["survival", "metric.survival_rate"] ] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={metric === key} onClick={() => { setMetric(key); setActive(null); }}>{t(label)}</button>)}
      </div><span className="home-context-name">{name}</span>
    </div>
    {first && last && <div className="home-progress-summary"><div><strong>{format(last.value)}</strong><span className={delta < 0 ? "home-negative" : "home-positive"}>{delta >= 0 ? "+" : ""}{n(delta)}{metric === "survival" ? ` ${t("home.percentPoints")}` : ""}</span></div><p>{date(first.at)} – {date(last.at)}</p></div>}
    <div className="home-chart-container" ref={ref}>
      {!first ? <p className="home-empty" role="status">{t(timeline === undefined ? "common.loading" : timeline === null ? "progression.unavailable" : "progression.noHistory")}</p> : <>
        <svg viewBox={`0 0 ${width} ${height}`} role="group" tabIndex={0} aria-label={t("home.chartAlt", { name })} aria-describedby={statusId}
          onPointerMove={(event) => { if (event.pointerType !== "touch") inspect(event); }}
          onPointerLeave={(event) => { if (event.pointerType !== "touch" && !event.currentTarget.matches(":focus-visible")) setActive(null); }}
          onClick={inspect} onFocus={() => show(points.length - 1)} onBlur={() => setActive(null)}
          onKeyDown={(event) => { if (event.key === "Escape") setActive(null); else if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); show(Math.max(0, Math.min(points.length - 1, (active ?? points.length - 1) + (event.key === "ArrowLeft" ? -1 : 1)))); } }}>
          <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--foreground)" stopOpacity=".12" /><stop offset="1" stopColor="var(--foreground)" stopOpacity="0" /></linearGradient></defs>
          {ticks.map((value) => <g key={value} aria-hidden="true"><line x1={left} y1={y(value)} x2={width - right} y2={y(value)} className="home-chart-grid" /><text data-chart-tick x={left - 10} y={y(value) + 5} textAnchor="end">{n(value, metric === "level" ? 0 : 1)}</text></g>)}
          {xTickValues.map((value, index) => <text key={index} data-chart-tick x={x(value)} y={height - 4} textAnchor={index === 0 ? "start" : index === xTickValues.length - 1 ? "end" : "middle"} aria-hidden="true">{n(value, 0)}</text>)}
          <path d={`${d} L${x(maxX)},${height - bottom} L${x(minX)},${height - bottom} Z`} fill={`url(#${gradientId})`} />
          <path d={d} className="home-chart-line" />
          {points.map((point, index) => <circle key={index} cx={x(point.raids)} cy={y(point.value)} r={3.5} className="home-chart-point" />)}
          <ChartCrosshair point={displayed ? { x: x(displayed.raids), y: y(displayed.value), xLabel: n(displayed.raids, 0), yLabel: format(displayed.value), color: "var(--foreground)" } : null} visible={!!current} left={left} bottom={height - bottom} labelY={height - 4} width={width} />
        </svg>
        <span id={statusId} className="sr-only" role="status">{current && `${date(current.at)}, ${t(metric === "level" ? "metric.level" : metric === "pvp_kd" ? "metric.pmc_kd_ratio" : "metric.survival_rate")}: ${format(current.value)}, ${t("home.pointRaids", { n: n(current.raids, 0) })}`}</span>
      </>}
    </div>
    <div className="home-chart-foot">{t("metric.pmc_raids")}</div>
  </>;
}
