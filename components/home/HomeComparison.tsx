"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { HOME_RADAR_METRICS, homePercentageDifference, homeRadarRatio, type HomeProfile, type HomeCohort } from "@/lib/home-showcase";
import { loadPlayerProfileResponse } from "@/lib/client-profile-request";
import { useFavorites } from "@/lib/favorites/context";
import { useChartWidth } from "./useChartWidth";

export default function HomeComparison({ profile, cohort }: {
  profile: HomeProfile | null | undefined;
  cohort: HomeCohort | null | undefined;
}) {
  const { t, lang } = useI18n();
  const [mode, setMode] = useState<"average" | "favorite">("average");
  const [active, setActive] = useState<{ index: number; x: number; y: number } | null>(null);
  const [favAid, setFavAid] = useState<number | null>(null);
  const [favProfile, setFavProfile] = useState<HomeProfile | null | undefined>(undefined);
  const { favorites, authStatus, loading: favsLoading } = useFavorites();
  const tooltipRef = useRef<HTMLDivElement>(null);
  const { ref, width } = useChartWidth(720);
  const mobile = width < 500, height = mobile ? 350 : 430, radius = mobile ? Math.min(115, (width - 70) * .4) : 150;
  const name = profile?.viewModel.identity.nickname ?? "";
  const isGuest = authStatus === "unauthenticated";
  const regularFavorites = favorites.filter((favorite) => favorite.mode === "regular");
  const defaultFavAid = regularFavorites.find((favorite) => favorite.isMain)?.aid ?? regularFavorites[0]?.aid ?? null;
  const effectiveFavAid = favAid != null && regularFavorites.some((favorite) => favorite.aid === favAid) ? favAid : defaultFavAid;
  const favEntry = regularFavorites.find((favorite) => favorite.aid === effectiveFavAid);
  const favName = favProfile?.viewModel.identity.nickname ?? favEntry?.nickname ?? (effectiveFavAid != null ? `AID ${effectiveFavAid}` : "");
  const otherName = mode === "average" ? t("radar.series.average") : favName;
  useEffect(() => {
    if (mode !== "favorite" || isGuest || effectiveFavAid == null) return;
    let cancelled = false;
    setFavProfile(undefined);
    async function loadFavorite() {
      try {
        const response = await loadPlayerProfileResponse<HomeProfile>(`/api/player/profile?aid=${effectiveFavAid}&mode=regular`);
        if (!cancelled) setFavProfile(response.ok && response.body.identity?.aid === effectiveFavAid && response.body.viewModel ? response.body : null);
      } catch { if (!cancelled) setFavProfile(null); }
    }
    void loadFavorite();
    return () => { cancelled = true; };
  }, [mode, isGuest, effectiveFavAid]);

  const favProfileKnown = favProfile && favProfile.comparisonStats?.pvpStatsKnown !== false;
  const loading = profile === undefined || cohort === undefined || (mode === "favorite" && !isGuest && (favsLoading || (regularFavorites.length > 0 && favProfile === undefined)));
  const ready = Boolean(profile) && profile?.comparisonStats?.pvpStatsKnown !== false && cohort?.quality === "sufficient" && (mode === "average" || Boolean(favProfileKnown));
  const statusKey = mode === "favorite" && isGuest ? "home.favoriteNeedAuth"
    : mode === "favorite" && !favsLoading && regularFavorites.length === 0 ? "home.noFavorites"
    : loading ? "common.loading" : "home.comparisonUnavailable";
  const metrics = HOME_RADAR_METRICS.map((metric) => {
    const average = cohort?.averages[metric.key];
    const baseline = average && average.count >= (metric.key === "pmc_survival_rate" ? 1 : 20) ? average.value : null;
    return { ...metric, baseline, a: profile?.comparisonStats?.[metric.stat] ?? null, b: mode === "average" ? baseline : favProfile?.comparisonStats?.[metric.stat] ?? null };
  });
  const point = (index: number, r: number) => { const angle = ([-150, -90, -30, 30, 90, 150][index] * Math.PI) / 180; return { x: width / 2 + Math.cos(angle) * r, y: height / 2 + Math.sin(angle) * r }; };
  const polygon = (points: { x: number; y: number }[]) => points.map((p) => `${p.x},${p.y}`).join(" ");
  const number = (value: number | null, digits: number) => value == null || !Number.isFinite(value) ? "—" : value.toLocaleString(lang, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const valueText = (value: number | null, index: number) => number(value, metrics[index].digits) + (value != null && index === 3 ? "%" : "");
  const differenceText = (index: number) => { const difference = homePercentageDifference(metrics[index].a, metrics[index].b); return difference == null ? "—" : `${difference > 0 ? "+" : difference < 0 ? "−" : ""}${number(Math.abs(difference), 1)}%`; };
  const differenceLabel = t("home.radarDifference", { name: mode === "average" ? t("home.averageTarget") : otherName });
  const selected = active ? metrics[active.index] : null;

  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    if (!active || !tooltip) return;
    const { width: tipWidth, height: tipHeight } = tooltip.getBoundingClientRect();
    const left = active.x + 14 + tipWidth > width - 8 ? active.x - tipWidth - 14 : active.x + 14;
    const top = active.y + 14 + tipHeight > height - 8 ? active.y - tipHeight - 14 : active.y + 14;
    tooltip.style.left = `${Math.max(8, Math.min(left, width - tipWidth - 8))}px`;
    tooltip.style.top = `${Math.max(8, Math.min(top, height - tipHeight - 8))}px`;
  }, [active, width, height, lang]);

  function show(index: number, p: { x: number; y: number }, event?: { clientX: number; clientY: number; currentTarget: SVGCircleElement }) {
    const bounds = event?.currentTarget.ownerSVGElement?.getBoundingClientRect();
    setActive({ index, x: event && bounds ? event.clientX - bounds.left : p.x, y: event && bounds ? event.clientY - bounds.top : p.y });
  }

  return <>
    <div className="home-segments home-compare-switch" role="group" aria-label={t("home.compareWith")}>
      <button type="button" aria-pressed={mode === "average"} onClick={() => { setMode("average"); setActive(null); }}>{t("home.averagePlayer")}</button>
      <button type="button" aria-pressed={mode === "favorite"} title={isGuest ? t("home.favoriteNeedAuth") : undefined}
        onClick={() => { if (isGuest) window.location.href = "/api/auth/google"; else { setMode("favorite"); setActive(null); } }}>{t("home.favoritePlayer")}</button>
    </div>
    {isGuest && <p className="home-risk-note">{t("home.favoriteNeedAuth")}</p>}
    {mode === "favorite" && !isGuest && !favsLoading && regularFavorites.length > 0 && <label className="home-compare-favorite">
      <span>{t("home.favoritePlayer")}</span>
      <select value={effectiveFavAid ?? ""} onChange={(event) => { setFavAid(Number(event.target.value)); setActive(null); }}>
        {regularFavorites.map((favorite) => <option key={favorite.aid} value={favorite.aid}>{favorite.nickname ?? `AID ${favorite.aid}`}</option>)}
      </select>
    </label>}
    {ready && <div className="home-radar-legend"><span><i aria-hidden="true" />{name}</span><span><i className="home-other-key" aria-hidden="true" />{otherName}</span></div>}
    <div ref={ref} className="home-comparison-chart">
      {!ready ? <p className="home-empty" role="status">{t(statusKey)}</p> : <>
        <svg viewBox={`0 0 ${width} ${height}`} role="group" aria-label={t("home.radarTitle")}>
          {[.25, .5, .75, 1].map((ratio) => <polygon key={ratio} points={polygon(metrics.map((_, index) => point(index, radius * ratio)))} fill="none" stroke="var(--card-border)" strokeWidth={ratio === 1 ? 1.5 : 1} />)}
          {metrics.map((metric, index) => { const p = point(index, radius); return <line key={metric.key} x1={width / 2} y1={height / 2} x2={p.x} y2={p.y} stroke="var(--card-border)" />; })}
          {(["b", "a"] as const).map((series) => {
            const points = metrics.map((metric, index) => { const ratio = homeRadarRatio(metric[series], metric.baseline); return ratio == null ? null : point(index, ratio * radius); });
            const color = series === "a" ? "var(--foreground)" : "var(--muted-strong)";
            return <g key={series}>
              {points.every((p) => p != null) && <polygon className="home-radar-series" points={polygon(points)} fill={series === "a" ? color : "none"} fillOpacity=".06" stroke={color} strokeWidth={2.5} strokeDasharray={series === "b" ? "7 6" : undefined} />}
              {points.map((p, index) => p && <g key={index}>{series === "a" ? <circle cx={p.x} cy={p.y} r={4} fill={color} /> : <rect x={p.x - 3.5} y={p.y - 3.5} width={7} height={7} fill={color} />}</g>)}
            </g>;
          })}
          {metrics.map((metric, index) => {
            const p = point(index, radius + (mobile ? 48 : 46)), side = index !== 1 && index !== 4, right = index === 2 || index === 3;
            const x = mobile && side ? right ? width - 4 : 4 : p.x;
            const axisKey = ["radar.metric.kd", "radar.metric.pmcKd", "home.radarKills", "home.radarSurvival", "home.radarStreak", "metric.level"][index];
            return <text key={metric.key} x={x} y={p.y} textAnchor={mobile && side ? right ? "end" : "start" : "middle"} className="home-radar-label">{t(axisKey).split("|").map((line, row) => <tspan key={row} x={x} dy={row ? 17 : 0}>{line}</tspan>)}</text>;
          })}
          {metrics.flatMap((metric, index) => (["b", "a"] as const).map((series) => {
            const ratio = homeRadarRatio(metric[series], metric.baseline);
            if (ratio == null) return null;
            const p = point(index, ratio * radius);
            return <circle key={`${metric.key}-${series}`} className="home-radar-hit" data-series={series} data-metric={metric.key} cx={p.x} cy={p.y} r={16} fill="transparent" tabIndex={series === "a" ? 0 : -1} role="button"
              aria-label={`${t(metric.label)}: ${name} ${valueText(metric.a, index)}, ${otherName} ${valueText(metric.b, index)}. ${differenceLabel}: ${differenceText(index)}`}
              onPointerEnter={(event) => show(index, p, event)} onPointerMove={(event) => show(index, p, event)} onPointerLeave={(event) => { if (!event.currentTarget.matches(":focus-visible")) setActive(null); }}
              onFocus={() => show(index, p)} onBlur={() => setActive(null)} onClick={(event) => show(index, p, event)}
              onKeyDown={(event) => { if (event.key === "Escape") setActive(null); if (event.key === "Enter" || event.key === " ") { event.preventDefault(); show(index, p); } }} />;
          }))}
        </svg>
        {active && selected && <div ref={tooltipRef} className="home-radar-tooltip" role="status">
          <strong>{t(selected.label)}</strong><div><span>{name}</span><b>{valueText(selected.a, active.index)}</b></div><div><span>{otherName}</span><b>{valueText(selected.b, active.index)}</b></div>
          <div className="home-radar-difference"><span>{differenceLabel}</span><b>{differenceText(active.index)}</b></div>
          {selected.b === 0 && selected.a !== 0 && <p>{t("home.noPercentage")}</p>}
        </div>}
      </>}
    </div>
    {ready && <div className="sr-only"><table><caption>{t("home.radarTitle")}</caption><thead><tr><th scope="col">{t("home.metric")}</th><th scope="col">{name}</th><th scope="col">{otherName}</th></tr></thead><tbody>{metrics.map((metric, index) => <tr key={metric.key}><th scope="row">{t(metric.label)}</th><td>{valueText(metric.a, index)}</td><td>{valueText(metric.b, index)}</td></tr>)}</tbody></table></div>}
  </>;
}
