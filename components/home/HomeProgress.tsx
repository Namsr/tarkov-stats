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
  const { ref, width } = useChartWidth(1120);
  const gradientId = useId();
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
  const xTickValues = Array.from({ length: xTickCount }, (_, index) => minX + (maxX - minX) * index / Math.max(1, xTickCount - 1));
  const current = active == null ? null : points[active] ?? null;
  const delta = first && last ? last.value - first.value : 0;

  const CHAR_W = 7.5;
  const LABEL_PAD = 3;
  type LabelRect = { x0: number; x1: number; y0: number; y1: number };
  function textW(s: string) { return String(s).length * CHAR_W; }
  function labelRect(xc: number, baseY: number, anchor: string, str: string): LabelRect {
    const w = textW(str);
    const x0 = anchor === "start" ? xc : anchor === "end" ? xc - w : xc - w / 2;
    return { x0, x1: x0 + w, y0: baseY - 11, y1: baseY + 3 };
  }
  function rectsOverlap(a: LabelRect, b: LabelRect) {
    return a.x0 - LABEL_PAD < b.x1 && b.x0 - LABEL_PAD < a.x1 &&
      a.y0 - LABEL_PAD < b.y1 && b.y0 - LABEL_PAD < a.y1;
  }

  const activeYLabel = current ? format(current.value) : "";
  const activeXLabel = current ? n(current.raids, 0) : "";
  const activeYRect: LabelRect | null = current ? labelRect(left - 10, y(current.value) + 5, "end", activeYLabel) : null;
  const activeXRect: LabelRect | null = current ? labelRect(x(current.raids), height - 4, "middle", activeXLabel) : null;

  const yTickInfos = ticks.map((value) => {
    const label = n(value, metric === "level" ? 0 : 1);
    return { value, label, rect: labelRect(left - 10, y(value) + 5, "end", label) };
  });
  const xTickInfos = xTickValues.map((value, index) => {
    const anchor: "start" | "middle" | "end" = index === 0 ? "start" : index === xTickValues.length - 1 ? "end" : "middle";
    const label = n(value, 0);
    return { value, index, anchor, label, rect: labelRect(x(value), height - 4, anchor, label) };
  });

  return <>
    <div className="home-progress-controls">
      <div className="home-segments" role="group" aria-label={t("home.chartMetric")}>
        {([ ["level", "metric.level"], ["pvp_kd", "metric.pmc_kd_ratio"], ["survival", "metric.survival_rate"] ] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={metric === key} onClick={() => { setMetric(key); setActive(null); }}>{t(label)}</button>)}
      </div><span className="home-context-name">{name}</span>
    </div>
    {first && last && <div className="home-progress-summary"><div><strong>{format(last.value)}</strong><span className={delta < 0 ? "home-negative" : "home-positive"}>{delta >= 0 ? "+" : ""}{n(delta)}{metric === "survival" ? ` ${t("home.percentPoints")}` : ""}</span></div><p>{date(first.at)} – {date(last.at)}</p></div>}
    <div className="home-chart-container" ref={ref}>
      {!first ? <p className="home-empty" role="status">{t(timeline === undefined ? "common.loading" : timeline === null ? "progression.unavailable" : "progression.noHistory")}</p> : <>
        <svg viewBox={`0 0 ${width} ${height}`} role="group" aria-label={t("home.chartAlt", { name })}
          onPointerLeave={() => setActive(null)}>
          <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--foreground)" stopOpacity=".12" /><stop offset="1" stopColor="var(--foreground)" stopOpacity="0" /></linearGradient></defs>
          {yTickInfos.map((info) => {
            const faded = activeYRect ? rectsOverlap(info.rect, activeYRect) : false;
            return <g key={info.value} aria-hidden="true"><line x1={left} y1={y(info.value)} x2={width - right} y2={y(info.value)} className="home-chart-grid" /><text x={left - 10} y={y(info.value) + 5} textAnchor="end" className="home-chart-tick" style={{ opacity: faded ? 0 : 1 }}>{info.label}</text></g>;
          })}
          {xTickInfos.map((info) => {
            const faded = activeXRect ? rectsOverlap(info.rect, activeXRect) : false;
            return <text key={info.index} x={x(info.value)} y={height - 4} textAnchor={info.anchor} aria-hidden="true" className="home-chart-tick" style={{ opacity: faded ? 0 : 1 }}>{info.label}</text>;
          })}
          <path d={`${d} L${x(maxX)},${height - bottom} L${x(minX)},${height - bottom} Z`} fill={`url(#${gradientId})`} />
          <path d={d} className="home-chart-line" />
          {points.filter((_, index) => index === 0 || index === points.length - 1 || (width > 600 && index % 3 === 0)).map((point, index) => <circle key={index} cx={x(point.raids)} cy={y(point.value)} r={3.5} className="home-chart-point" />)}
          <g className="home-chart-fade" opacity={current ? 1 : 0} aria-hidden="true">{current && <>
            <line x1={x(current.raids)} x2={x(current.raids)} y1={y(current.value)} y2={height - bottom} className="home-chart-crosshair" />
            <line x1={left} x2={x(current.raids)} y1={y(current.value)} y2={y(current.value)} className="home-chart-crosshair" />
            <circle cx={x(current.raids)} cy={y(current.value)} r={6} fill="var(--foreground)" />
            <text x={left - 10} y={y(current.value) + 5} textAnchor="end" className="home-chart-axis-active" style={{ fill: "var(--foreground)" }}>{activeYLabel}</text>
            <text x={x(current.raids)} y={height - 4} textAnchor="middle" className="home-chart-axis-active" style={{ fill: "var(--foreground)" }}>{activeXLabel}</text>
          </>}</g>
          {points.map((point, index) => <circle key={`hit-${index}`} cx={x(point.raids)} cy={y(point.value)} r={13} fill="transparent" onPointerEnter={() => setActive(index)} onPointerMove={() => setActive(index)} onPointerLeave={() => setActive(null)} />)}
        </svg>
      </>}
    </div>
    <div className="home-chart-foot">{t("metric.pmc_raids")}</div>
  </>;
}
