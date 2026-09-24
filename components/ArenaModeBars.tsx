"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { ARENA_MODE_KEYS, type ArenaProfile, type ArenaModeKey, type ArenaStoredMode, type ArenaStatistic, type ArenaCohortResult } from "@/types/arena";
import { arenaBarPosition, arenaCohortMatchesBaseline, arenaMetricBaseline, loadArenaModeBaselines, type ArenaModeBaselinesPurpose } from "@/components/arena-ui";

type BarMetric = "matches" | "kd_ratio" | "win_rate";
type Outcome = "wins" | "losses";

function purposeFor(metric: BarMetric): ArenaModeBaselinesPurpose {
  // Матчи: всегда population-среднее по режиму. Matched-когорта отобрана по похожим
  // matches и дала бы ratio≈1 для всех строк — сравнение режимов стало бы плоским.
  return metric === "matches" ? "matches" : "comparison";
}

export default function ArenaModeBars({ profile, selected, onSelect, aid, statistic }: {
  profile: ArenaProfile; selected: ArenaStoredMode; onSelect: (mode: ArenaModeKey) => void;
  aid: number; statistic: ArenaStatistic;
}) {
  const { t, lang } = useI18n();
  const [metric, setMetric] = useState<BarMetric>("matches");
  const [active, setActive] = useState<{ mode: ArenaModeKey; outcome: Outcome; x: number; y: number } | null>(null);
  const [cohorts, setCohorts] = useState<Partial<Record<ArenaModeKey, ArenaCohortResult | null>>>({});
  const [unavailable, setUnavailable] = useState<ArenaModeKey[]>([]);
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const cacheRef = useRef(new Map<string, { cohorts: Partial<Record<ArenaModeKey, ArenaCohortResult | null>>; unavailable: ArenaModeKey[] }>());
  const sectionRef = useRef<HTMLElement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null), tipRef = useRef<HTMLDivElement>(null);
  const value = (mode: ArenaModeKey) => metric === "matches" ? profile.modes[mode].counters.matches : profile.modes[mode].metrics[metric];
  const max = metric === "win_rate" ? 100 : Math.max(1, ...ARENA_MODE_KEYS.map((mode) => value(mode) ?? 0));
  const number = (v: number | null, digits = 0) => v == null || !Number.isFinite(v) ? "—" : v.toLocaleString(lang, { maximumFractionDigits: digits });

  // Секция ниже сгиба: не дергаем API, пока пользователь не доскроллил.
  useEffect(() => {
    const node = sectionRef.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "200px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    let activeRequest = true;
    const purpose = purposeFor(metric);
    // Один батч-запрос на aid+статистику+тип базы вместо 5×cohort (+5×fallback).
    const cacheKey = `${aid}:${statistic}:${purpose}`;
    setLoading(true);
    setError("");
    (async () => {
      try {
        const cached = cacheRef.current.get(cacheKey);
        const result = cached ?? await loadArenaModeBaselines(aid, statistic, purpose, controller.signal);
        if (!cached) cacheRef.current.set(cacheKey, result);
        if (!activeRequest) return;
        setCohorts(result.cohorts);
        setUnavailable(result.unavailable);
        if (Object.values(result.cohorts).every((cohort) => cohort == null)) setError(t("arena.radar.error"));
      } catch (caught: unknown) {
        if (!activeRequest || (caught instanceof Error && caught.name === "AbortError")) return;
        setCohorts({});
        setUnavailable([]);
        setError(t("arena.radar.error"));
      } finally {
        if (activeRequest) setLoading(false);
      }
    })();
    return () => {
      activeRequest = false;
      controller.abort();
    };
  }, [aid, statistic, metric, visible, t]);

  const baselineFor = (mode: ArenaModeKey): number | null => {
    const cohort = cohorts[mode] ?? null;
    if (metric === "matches") return arenaCohortMatchesBaseline(cohort);
    return arenaMetricBaseline(cohort, metric);
  };
  const baselineText = (mode: ArenaModeKey) => {
    const b = baselineFor(mode);
    return b == null ? t("common.notAvailable") : metric === "win_rate" ? `${number(b, 1)}%` : number(b, metric === "kd_ratio" ? 2 : 0);
  };
  const hasAnyBaseline = ARENA_MODE_KEYS.some((mode) => baselineFor(mode) != null);

  function show(mode: ArenaModeKey, outcome: Outcome, event: { currentTarget: HTMLElement; clientX?: number; clientY?: number }) {
    const root = event.currentTarget.closest<HTMLElement>(".profile-arena-bars");
    if (!root) return;
    const rect = root.getBoundingClientRect(), row = root.querySelector(`[data-mode="${mode}"]`)?.getBoundingClientRect();
    setActive({ mode, outcome, x: event.clientX != null ? event.clientX - rect.left : rect.width * .55, y: event.clientY != null ? event.clientY - rect.top : row ? row.top - rect.top + row.height / 2 : 0 });
  }
  useLayoutEffect(() => {
    const root = rootRef.current, tip = tipRef.current;
    if (!active || !root || !tip) return;
    const { width, height } = root.getBoundingClientRect(), { width: w, height: h } = tip.getBoundingClientRect();
    const left = active.x + 14 + w > width - 8 ? active.x - w - 14 : active.x + 14;
    const top = active.y + 14 + h > height - 8 ? active.y - h - 14 : active.y + 14;
    tip.style.left = `${Math.max(8, Math.min(left, width - w - 8))}px`;
    tip.style.top = `${Math.max(8, Math.min(top, height - h - 8))}px`;
  }, [active]);

  return <section id="arena-modes" ref={sectionRef} tabIndex={-1} className="profile-anchor-section">
    <div className="profile-collection__heading"><h2 className="section-heading">{t("arena.byMode")}</h2>
      <div className="profile-segments" role="group" aria-label={t("home.chartMetric")}>{(["matches", "kd_ratio", "win_rate"] as const).map((key) => <button key={key} type="button" aria-pressed={metric === key} onClick={() => { setMetric(key); setActive(null); }}>{t(key === "matches" ? "arena.counter.matches" : "arena.metric." + key)}</button>)}</div>
    </div>
    {(loading || error) && <p className="profile-chart-notice" role="status">{error || t("arena.radar.loading")}</p>}
    {!loading && !error && unavailable.length > 0 && <p className="profile-chart-notice" role="status">{t("profile.averageUnavailable")}</p>}
    {!loading && !error && hasAnyBaseline && <div className="arena-bars-legend" aria-hidden="true"><span><i className="arena-bars-average-key" />{t("arena.combat.averageMarker")}</span></div>}
    <div ref={rootRef} className="profile-arena-bars" onPointerLeave={() => setActive(null)}>
      {ARENA_MODE_KEYS.map((mode) => {
        const v = value(mode), counters = profile.modes[mode].counters;
        const baseline = baselineFor(mode);
        const pos = baseline != null ? arenaBarPosition(v, baseline) : null;
        // Без базы (когорта недоступна или среднего нет): старый max-масштаб без черты, чтобы бар не пустовал.
        const fallbackWidth = v != null && Number.isFinite(v) ? Math.max(0, Math.min(100, v / max * 100)) : 0;
        const width = pos ?? fallbackWidth;
        return <button key={mode} type="button" className="profile-arena-bar" data-mode={mode} aria-pressed={selected === mode}
          aria-label={`${t("arena.mode." + mode)}: ${number(v, metric === "kd_ratio" ? 2 : 1)}${metric === "win_rate" ? "%" : ""}${metric === "matches" ? `, ${t("arena.counter.wins")} ${number(counters.wins)}, ${t("arena.counter.losses")} ${number(counters.losses)}` : ""}; ${t("radar.series.average")}: ${baselineText(mode)}`}
          aria-keyshortcuts={metric === "matches" ? "ArrowLeft ArrowRight Escape" : undefined}
          onClick={() => onSelect(mode)} onFocus={(event) => { if (metric === "matches") show(mode, "wins", event); }} onBlur={() => setActive(null)}
          onKeyDown={(event) => { if (event.key === "Escape") setActive(null); if (metric === "matches" && (event.key === "ArrowLeft" || event.key === "ArrowRight")) { event.preventDefault(); show(mode, event.key === "ArrowLeft" ? "wins" : "losses", event); } }}>
          <span className="profile-arena-bar__name">{t("arena.mode." + mode)}</span>
          <span className="profile-arena-bar__track" aria-hidden="true"><span className="profile-arena-bar__fill" style={{ width: `${width}%` }}>
            {metric === "matches" ? (["wins", "losses"] as const).map((outcome) => <i key={outcome} data-outcome={outcome} style={{ width: `${counters.matches && counters[outcome] != null ? Math.max(0, Math.min(100, counters[outcome] / counters.matches * 100)) : 0}%` }} onPointerEnter={(event) => show(mode, outcome, event)} onPointerMove={(event) => show(mode, outcome, event)} onClick={(event) => { event.stopPropagation(); show(mode, outcome, event); }} />) : <i style={{ width: "100%" }} />}
          </span>{baseline != null && <span className="profile-arena-bar__average" />}</span>
          <strong>{number(v, metric === "kd_ratio" ? 2 : metric === "win_rate" ? 1 : 0)}{v != null && metric === "win_rate" ? "%" : ""}</strong>
        </button>;
      })}
      {active && <div ref={tipRef} className="profile-chart-tooltip profile-arena-tooltip" role="status"><div><span>{t("arena.counter." + active.outcome)}</span><b>{number(profile.modes[active.mode].counters[active.outcome])}</b></div></div>}
    </div>
    {metric === "matches" && <div className="profile-chart-legend profile-arena-bar-legend"><span><i className="is-wins" aria-hidden="true" />{t("arena.counter.wins")}</span><span><i className="is-losses" aria-hidden="true" />{t("arena.counter.losses")}</span></div>}
  </section>;
}
