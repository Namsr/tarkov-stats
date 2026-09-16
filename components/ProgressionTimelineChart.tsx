"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { useChartWidth } from "@/components/home/useChartWidth";
import { profileChartTicks, profileProgressionSegments, profileProgressionTime, type ProfileProgressMetric } from "@/lib/profile-progression";
import { cumulativeLevelBands, levelAtExperience } from "@/lib/seasonal/ui";
import { PLAYER_LEVELS_V2026_07_22 } from "@/lib/tarkov-api";
import type { ProgressionAverageResponse, ProgressionPoint, ProgressionTimelineResponse } from "@/types/seasonal";

const LEVEL_BANDS = cumulativeLevelBands(PLAYER_LEVELS_V2026_07_22);
type ChartPoint = { point: ProgressionPoint; x: number; y: number; kind: "player" | "overall" | "selected" };

export default function ProgressionTimelineChart({ data, title, comparison }: {
  data: ProgressionTimelineResponse;
  title?: string;
  comparison?: { aid: number; nickname: string; timeline: ProgressionTimelineResponse };
}) {
  const { t, lang } = useI18n();
  const [metric, setMetric] = useState<ProfileProgressMetric>("level");
  const [allHistory, setAllHistory] = useState(false);
  const [axis, setAxis] = useState<"raids" | "days">("raids");
  const [overall, setOverall] = useState(true);
  const [fullRange, setFullRange] = useState(false);
  const [active, setActive] = useState<{ item: ChartPoint; x: number; y: number } | null>(null);
  const [fallback, setFallback] = useState<{ key: string; points: ProgressionPoint[] } | null>(null);
  const { ref, width } = useChartWidth(1120);
  const svgRef = useRef<SVGSVGElement>(null);
  const titleId = useId(), clipId = useId();
  const key = metric === "level" ? "xp" : metric === "kd" ? data.identity.mode === "pve" ? "ai_kd" : "pvp_kd" : "survival";
  const series = data.metrics[key];
  const fallbackKey = `${data.identity.mode}:${data.identity.cycleId}`;
  const needsFallback = !data.metrics.xp?.overall.length;

  useEffect(() => {
    if (!needsFallback) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ mode: data.identity.mode, cycle: data.identity.cycleId });
    fetch(`/api/progression/average?${params}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return null;
        const body = await response.json() as ProgressionAverageResponse;
        return body.mode === data.identity.mode && body.cycleId === data.identity.cycleId && Array.isArray(body.series?.cumulative?.overall)
          ? body.series.cumulative.overall : null;
      })
      .then((points) => { if (points && !controller.signal.aborted) setFallback({ key: fallbackKey, points }); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [data.identity.mode, data.identity.cycleId, fallbackKey, needsFallback]);

  const overallLabel = t(data.identity.mode === "pve" ? "progression.series.overall.pve" : "progression.series.overall");
  const source = useMemo(() => (series?.player ?? []).map((point) => metric === "level" && point.level == null
    ? { ...point, level: Number.isFinite(point.value) ? levelAtExperience(point.value, LEVEL_BANDS) : null } : point), [series, metric]);
  const segments = profileProgressionSegments(source, metric, allHistory);
  const player = segments.flat();
  const current = profileProgressionSegments(source, metric, false).flat();
  const averageSource = series?.overall.length ? series.overall : metric === "level" && fallback?.key === fallbackKey ? fallback.points : [];
  const average = averageSource.filter((point) => Number.isFinite(point.pmcRaids) && Number.isFinite(point.value)).map((point) => ({ ...point, value: metric === "level" ? point.level ?? levelAtExperience(point.value, LEVEL_BANDS) : point.value }));
  const comparisonSource = (comparison?.timeline.metrics[key]?.player ?? []).map((point) => metric === "level" && point.level == null
    ? { ...point, level: Number.isFinite(point.value) ? levelAtExperience(point.value, LEVEL_BANDS) : null } : point);
  const selectedSegments = profileProgressionSegments(comparisonSource, metric, allHistory);
  const selected = selectedSegments.flat();
  const coordinate = (point: ProgressionPoint) => axis === "raids" ? point.pmcRaids : profileProgressionTime(point);
  const makePoints = (points: readonly ProgressionPoint[], kind: ChartPoint["kind"]): ChartPoint[] => points.flatMap((point) => {
    const x = coordinate(point);
    return x != null && Number.isFinite(x) && Number.isFinite(point.value) ? [{ point, kind, x, y: point.value }] : [];
  });
  const playerPoints = makePoints(player, "player"), selectedPoints = makePoints(selected, "selected");
  const playerX = [...playerPoints, ...selectedPoints].map((p) => p.x);
  const showOverall = overall && axis === "raids" && average.length > 0;
  const minX = axis === "raids" ? 0 : playerX.length ? Math.min(...playerX) : 0;
  const playerMax = playerX.length ? Math.max(...playerX) : 0;
  const maxX = axis === "days" ? Math.max(minX + 1, playerMax) : showOverall && (fullRange || !playerPoints.length)
    ? Math.max(1, playerMax, ...average.map((p) => p.pmcRaids)) : Math.max(30, Math.ceil(playerMax / 10 + 1) * 10);
  const overallPoints = showOverall ? makePoints(average, "overall").filter((p) => p.x >= minX && p.x <= maxX).sort((a, b) => a.x - b.x) : [];
  const all = [...overallPoints, ...selectedPoints, ...playerPoints];
  const values = all.map((p) => p.y), min = values.length ? Math.min(...values) : 0, max = values.length ? Math.max(...values) : 1;
  const range = max - min || Math.max(1, max * .2);
  let low = Math.max(0, min - range * .12), high = max + range * .15;
  if (metric === "level") { low = Math.floor(low); high = Math.ceil(high); }
  if (metric === "survival") high = Math.min(100, high);
  if (high <= low) low = Math.max(0, high - 1);
  const height = width < 500 ? 235 : 270, left = width < 400 ? 36 : 44, right = 18, top = 20, bottom = 34;
  const x = (v: number) => left + (v - minX) / Math.max(1, maxX - minX) * (width - left - right);
  const y = (v: number) => height - bottom - (v - low) / Math.max(1e-9, high - low) * (height - top - bottom);
  const n = (v: number, digits = 0) => v.toLocaleString(lang, { maximumFractionDigits: digits });
  const date = (at: number | null) => at == null ? "—" : new Date(at).toLocaleDateString(lang, { day: "numeric", month: "short", timeZone: "Europe/Moscow" });
  const format = (v: number) => n(v, metric === "level" ? 0 : metric === "kd" ? 2 : 1) + (metric === "survival" ? "%" : "");
  const ticks = profileChartTicks(axis === "days" ? [minX, (minX + maxX) / 2, maxX] : [0, maxX / 3, maxX * 2 / 3, maxX], (v) => axis === "days" ? date(v) : n(v));
  const yTicks = profileChartTicks(Array.from({ length: 4 }, (_, i) => low + (high - low) * i / 3), (v) => n(v, metric === "level" ? 0 : 1));
  const path = (points: ChartPoint[]) => points.map((p, i) => `${i ? "L" : "M"}${x(p.x)},${y(p.y)}`).join(" ");
  const last = current.at(-1), first = current[0], change = first && last ? last.value - first.value : null;
  const hasPrevious = new Set(source.map((p) => p.seriesId)).size > 1;

  useLayoutEffect(() => {
    const labels = [...(svgRef.current?.querySelectorAll<SVGTextElement>(".profile-chart-x-label") ?? [])];
    const accepted: DOMRect[] = [];
    for (const label of [...new Set([labels[0], labels.at(-1), ...labels.slice(1, -1)])]) {
      if (!label) continue;
      label.style.visibility = "visible";
      const box = label.getBBox();
      if (accepted.some((other) => box.x < other.x + other.width + 10 && box.x + box.width + 10 > other.x)) label.style.visibility = "hidden";
      else accepted.push(box);
    }
  }, [axis, width, minX, maxX, lang]);
  function show(item: ChartPoint) {
    setActive({ item, x: x(item.x), y: y(item.y) });
  }
  const clear = () => setActive(null);
  const [shown, setShown] = useState<typeof active>(null);
  useEffect(() => { if (active) setShown(active); }, [active]);
  const shownColor = shown?.item.kind === "overall" ? "var(--profile-positive)" : shown?.item.kind === "selected" ? "var(--profile-other)" : "var(--foreground)";
  const activeXLabel = active ? (axis === "days" ? date(active.item.x) : n(active.item.x)) : "";
  const activeYLabel = active ? format(active.item.y) : "";
  const CHAR_W = 7.2, LABEL_PAD = 3;
  const textWidth = (s: string) => String(s).length * CHAR_W;
  const labelRect = (lx: number, baseY: number, anchor: "start" | "middle" | "end", str: string) => {
    const w = textWidth(str);
    const x0 = anchor === "start" ? lx : anchor === "end" ? lx - w : lx - w / 2;
    return { x0, x1: x0 + w, y0: baseY - 11, y1: baseY + 3 };
  };
  const rectsOverlap = (a: { x0: number; x1: number; y0: number; y1: number }, b: { x0: number; x1: number; y0: number; y1: number }) =>
    a.x0 - LABEL_PAD < b.x1 && b.x0 - LABEL_PAD < a.x1 && a.y0 - LABEL_PAD < b.y1 && b.y0 - LABEL_PAD < a.y1;
  const activeYRect = active ? labelRect(left - 10, active.y + 4, "end", activeYLabel) : null;
  const activeXRect = active ? labelRect(active.x, height - 6, "middle", activeXLabel) : null;
  const shownXLabel = shown ? (axis === "days" ? date(shown.item.x) : n(shown.item.x)) : "";
  const shownYLabel = shown ? format(shown.item.y) : "";

  return <section className="profile-progress-chart" aria-labelledby={titleId}>
    <h3 id={titleId} className="sr-only">{title ?? t("progression.timeline.title")}</h3>
    <div className="profile-progress-controls">
      <div className="profile-segments" role="group" aria-label={t("home.chartMetric")}>
        {(["level", "kd", "survival"] as const).map((value) => <button key={value} type="button" data-metric={value} aria-pressed={metric === value} onClick={() => { setMetric(value); clear(); }}>{t(value === "level" ? "metric.level" : value === "kd" ? data.identity.mode === "pve" ? "progression.timeline.metric.aiKd" : "metric.pmc_kd_ratio" : "metric.survival_rate")}</button>)}
      </div>
      <label className="profile-select"><span className="sr-only">{t("profile.historyPeriod")}</span><select value={allHistory ? "all" : "current"} onChange={(event) => { setAllHistory(event.target.value === "all"); clear(); }}><option value="current">{t("profile.currentSeries")}</option><option value="all">{t("profile.allHistory")}</option></select></label>
    </div>
    <div className="profile-progress-topline">
      <div className="profile-progress-summary">{last ? <><div><strong>{format(last.value)}</strong>{change != null && <span className={change < 0 ? "is-negative" : undefined}>{change > 0 ? "+" : change < 0 ? "−" : ""}{n(Math.abs(change), metric === "level" ? 0 : metric === "kd" ? 2 : 1)}{metric === "survival" ? ` ${t("home.percentPoints")}` : ""}</span>}</div><p>{date(profileProgressionTime(player[0] ?? last))} – {date(profileProgressionTime(last))}{allHistory && hasPrevious ? ` · ${t("profile.currentSeries")}: ${date(first ? profileProgressionTime(first) : null)}` : ""}</p></> : null}</div>
      <div className="profile-chart-legend"><span><i aria-hidden="true" />{t("radar.series.player")}</span><button type="button" className="profile-legend-toggle" aria-pressed={overall && axis === "raids"} disabled={!average.length} onClick={() => { if (axis === "days") { setAxis("raids"); setOverall(true); } else setOverall((value) => !value); clear(); }}><i className="is-overall" aria-hidden="true" />{overallLabel}</button>{comparison && <span><i className="is-other" aria-hidden="true" />{comparison.nickname}</span>}</div>
    </div>
    <div ref={ref} className="profile-line-chart" style={{ height }}>
      {all.length ? <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={title ?? t("progression.timeline.title")} onPointerLeave={clear}>
        <defs><clipPath id={clipId}><rect x={left - 6} y={top - 6} width={width - left - right + 12} height={height - top - bottom + 12} /></clipPath></defs>
        {yTicks.map((tick) => {
          const rect = labelRect(left - 10, y(tick.value) + 4, "end", tick.label);
          const faded = activeYRect ? rectsOverlap(rect, activeYRect) : false;
          return <g key={tick.label} aria-hidden="true"><line x1={left} x2={width - right} y1={y(tick.value)} y2={y(tick.value)} stroke="var(--card-border)" /><text className="profile-chart-tick" style={{ opacity: faded ? 0 : 1 }} x={left - 10} y={y(tick.value) + 4} textAnchor="end">{tick.label}</text></g>;
        })}
        {ticks.map((tick, i) => {
          const anchor = i === 0 ? "start" as const : i === ticks.length - 1 ? "end" as const : "middle" as const;
          const rect = labelRect(x(tick.value), height - 6, anchor, tick.label);
          const faded = activeXRect ? rectsOverlap(rect, activeXRect) : false;
          return <text key={tick.label} className="profile-chart-x-label profile-chart-tick" style={{ opacity: faded ? 0 : 1 }} x={x(tick.value)} y={height - 6} textAnchor={anchor}>{tick.label}</text>;
        })}
        <g clipPath={`url(#${clipId})`}>
          {overallPoints.length > 0 && <path className="profile-chart-line is-overall" data-series="overall" d={path(overallPoints)} />}
          {comparison && selectedSegments.map((segment, i) => <path key={`selected-${i}`} data-series="selected" className="profile-chart-line is-selected" d={path(makePoints(segment, "selected"))} />)}
          {segments.map((segment, i) => <path key={i} data-series={segment[0]?.seriesId ?? "player"} className={`profile-chart-line ${segment[0]?.seriesId !== source.at(-1)?.seriesId ? "is-old" : ""}`} d={path(makePoints(segment, "player"))} />)}
          {all.map((item, i) => <g key={`${item.kind}:${item.point.pointId}:${i}`}>
            {item.kind === "overall" ? <rect x={x(item.x) - 3} y={y(item.y) - 3} width="6" height="6" fill="var(--profile-positive)" /> : <circle cx={x(item.x)} cy={y(item.y)} r="4" fill="var(--background)" stroke={item.kind === "selected" ? "var(--profile-other)" : "var(--foreground)"} strokeWidth="2" />}
          </g>)}
        </g>
        <g className="profile-chart-fade" opacity={active ? 1 : 0} aria-hidden="true">
          {shown && <>
            <line className="profile-chart-crosshair" x1={shown.x} x2={shown.x} y1={shown.y} y2={height - bottom} stroke={shownColor} />
            <line className="profile-chart-crosshair" x1={left} x2={shown.x} y1={shown.y} y2={shown.y} stroke={shownColor} />
            <circle cx={shown.x} cy={shown.y} r="6" fill={shownColor} />
            <text x={left - 10} y={shown.y + 4} textAnchor="end" className="profile-chart-axis-active" style={{ fill: shownColor }}>{shownYLabel}</text>
            <text x={shown.x} y={height - 6} textAnchor="middle" className="profile-chart-axis-active" style={{ fill: shownColor }}>{shownXLabel}</text>
          </>}
        </g>
        {all.map((item, i) => <circle key={`${item.kind}:${item.point.pointId}:${i}`} className="profile-chart-hit" data-kind={item.kind} cx={x(item.x)} cy={y(item.y)} r="13" fill="transparent"
          onPointerEnter={() => show(item)} onPointerMove={() => show(item)} onPointerLeave={clear} />)}
      </svg> : <p className="profile-chart-notice" role="status">{t("progression.noHistory")}</p>}
    </div>
    <div className="profile-progress-foot">
      <div className="profile-segments" role="group" aria-label={t("progression.timeline.axisHorizontal")}><button type="button" aria-pressed={axis === "raids"} onClick={() => { setAxis("raids"); clear(); }}>{t("progression.timeline.axisPmcRaids")}</button><button type="button" aria-pressed={axis === "days"} onClick={() => { setAxis("days"); clear(); }}>{t("progression.timeline.axisDays")}</button></div>
      {axis === "raids" && average.length > 0 && <button className="profile-text-button" type="button" aria-pressed={fullRange} onClick={() => { setFullRange((value) => !value); setOverall(true); clear(); }}>{t(fullRange ? "profile.playerRange" : "profile.fullRange")}</button>}
      {allHistory && hasPrevious && <span className="profile-history-key">{t("profile.previousCharacter")}</span>}
    </div>
    {!average.length && <p className="profile-chart-notice">{t("profile.averageUnavailable")}</p>}
  </section>;
}
