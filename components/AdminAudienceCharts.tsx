"use client";

import { useState, type KeyboardEvent, type PointerEvent } from "react";
import { useI18n } from "@/lib/i18n/context";
import type { AudienceGrowth, AudienceSummary } from "@/lib/admin/analytics-db";

export default function AdminAudienceCharts({ audience }: { audience: AudienceSummary }) {
  const { t } = useI18n();
  return <div>
    <div className="admin-audience-grid">
      <AudienceChart data={audience.users} kind="users" />
      <AudienceChart data={audience.visitors} kind="visitors" />
    </div>
    <p className="admin-chart-description">{t("admin.audience.history")}</p>
  </div>;
}

function AudienceChart({ data, kind }: { data: AudienceGrowth; kind: "users" | "visitors" }) {
  const { t, lang } = useI18n();
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const points = data.series;
  const selectedIndex = Math.max(0, selectedDay == null ? points.length - 1 : points.findIndex((point) => point.day === selectedDay));
  const selected = points[selectedIndex];
  const locale = lang === "ru" ? "ru-RU" : "en-US";
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const date = (day: string, short = false) => new Date(`${day}T00:00:00Z`).toLocaleDateString(locale, {
    timeZone: "UTC", ...(short ? { day: "numeric", month: "short" } as const : { dateStyle: "medium" } as const),
  });
  const left = 17;
  const right = 96;
  const top = 7;
  const bottom = 43;
  const chartHeight = 58;
  const max = Math.max(1, data.total);
  const xFor = (index: number) => points.length <= 1 ? (left + right) / 2 : left + index / (points.length - 1) * (right - left);
  const yFor = (total: number) => bottom - total / max * (bottom - top);
  const path = points.map((point, index) => index === 0
    ? `M${xFor(index)},${yFor(point.total)}`
    : `H${xFor(index)} V${yFor(point.total)}`).join(" ");
  const ticks = points.length < 3 ? points.map((_, index) => index) : [0, Math.floor((points.length - 1) / 2), points.length - 1];
  const anchor = (x: number) => x < 25 ? "translateX(0)" : x > 80 ? "translateX(-100%)" : "translateX(-50%)";

  function moveToPointer(event: PointerEvent<SVGSVGElement>) {
    if (!points.length) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / Math.max(1, rect.width) * 100;
    const index = Math.round(Math.max(0, Math.min(1, (x - left) / (right - left))) * (points.length - 1));
    setSelectedDay(points[index].day);
  }

  function moveByKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (!points.length || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = event.key === "Home" ? 0 : event.key === "End" ? points.length - 1
      : Math.max(0, Math.min(points.length - 1, selectedIndex + (event.key === "ArrowLeft" ? -1 : 1)));
    setSelectedDay(points[index].day);
  }

  const title = kind === "users" ? t("admin.audience.users.heading") : t("admin.audience.visitors.heading");
  return <section className="data-panel admin-panel admin-monitoring-chart">
    <h2 className="section-heading">{title}</h2>
    <p className="admin-chart-description">{kind === "users" ? t("admin.audience.users.description") : t("admin.audience.visitors.description")}</p>
    <div className="admin-audience-total"><strong>{number(data.total)}</strong><span>{t("admin.audience.total")}</span></div>
    {selected ? <>
      <div className="admin-chart-wrap admin-monitoring-chart__wrap" tabIndex={0} role="group"
        aria-label={t("admin.audience.aria", { title })} aria-keyshortcuts="ArrowLeft ArrowRight Home End" onKeyDown={moveByKeyboard}>
        <div className="admin-chart-stage admin-monitoring-chart__stage">
          <svg className="admin-chart" viewBox="0 0 100 58" preserveAspectRatio="none" aria-hidden="true" onPointerMove={moveToPointer} onPointerDown={moveToPointer}>
            {[top, bottom].map((y) => <line key={y} className="admin-chart__grid" x1={left} x2={right} y1={y} y2={y} />)}
            <path className="admin-chart__line admin-chart__line--pageviews" d={path} />
            <line className="admin-chart__crosshair" x1={xFor(selectedIndex)} x2={xFor(selectedIndex)} y1={top} y2={bottom} />
            <rect className="admin-chart__hit-area" x={left} y={top} width={right - left} height={bottom - top} fill="transparent" pointerEvents="all" />
          </svg>
          <div className="admin-chart-overlay" aria-hidden="true">
            <span className="admin-chart__axis admin-chart__axis--max" style={{ top: `${top / chartHeight * 100}%` }}>{number(max)}</span>
            <span className="admin-chart__axis admin-chart__axis--zero" style={{ top: `${bottom / chartHeight * 100}%` }}>0</span>
            <span className="admin-chart__marker admin-chart__marker--pageviews" style={{ left: `${xFor(selectedIndex)}%`, top: `${yFor(selected.total) / chartHeight * 100}%` }} />
          </div>
        </div>
        <div className="admin-chart-axis" aria-hidden="true">{ticks.map((index) => <span key={points[index].day} style={{ left: `${xFor(index)}%`, transform: anchor(xFor(index)) }}>{date(points[index].day, true)}</span>)}</div>
      </div>
      <div className="admin-chart-selection" aria-live="polite">{t("admin.audience.selection", { date: date(selected.day), total: number(selected.total), added: number(selected.added) })}</div>
      <p className="admin-chart-hint">{t("admin.chart.keyboard")}</p>
    </> : <p className="admin-empty">{t("admin.empty")}</p>}
    {kind === "visitors" && <p className="admin-chart-description">{t("admin.audience.visitors.note")}</p>}
  </section>;
}
