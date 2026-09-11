"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { ARENA_MODE_KEYS, type ArenaProfile, type ArenaModeKey, type ArenaStoredMode } from "@/types/arena";

type BarMetric = "matches" | "kd_ratio" | "win_rate";
type Outcome = "wins" | "losses";

export default function ArenaModeBars({ profile, selected, onSelect }: {
  profile: ArenaProfile; selected: ArenaStoredMode; onSelect: (mode: ArenaModeKey) => void;
}) {
  const { t, lang } = useI18n();
  const [metric, setMetric] = useState<BarMetric>("matches");
  const [active, setActive] = useState<{ mode: ArenaModeKey; outcome: Outcome; x: number; y: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null), tipRef = useRef<HTMLDivElement>(null);
  const value = (mode: ArenaModeKey) => metric === "matches" ? profile.modes[mode].counters.matches : profile.modes[mode].metrics[metric];
  const max = metric === "win_rate" ? 100 : Math.max(1, ...ARENA_MODE_KEYS.map((mode) => value(mode) ?? 0));
  const number = (v: number | null, digits = 0) => v == null || !Number.isFinite(v) ? "—" : v.toLocaleString(lang, { maximumFractionDigits: digits });

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

  return <section id="arena-modes" tabIndex={-1} className="profile-anchor-section">
    <div className="profile-collection__heading"><h2 className="section-heading">{t("arena.byMode")}</h2>
      <div className="profile-segments" role="group" aria-label={t("home.chartMetric")}>{(["matches", "kd_ratio", "win_rate"] as const).map((key) => <button key={key} type="button" aria-pressed={metric === key} onClick={() => { setMetric(key); setActive(null); }}>{t(key === "matches" ? "arena.counter.matches" : "arena.metric." + key)}</button>)}</div>
    </div>
    <div ref={rootRef} className="profile-arena-bars" onPointerLeave={() => setActive(null)}>
      {ARENA_MODE_KEYS.map((mode) => {
        const v = value(mode), counters = profile.modes[mode].counters;
        const width = v != null && Number.isFinite(v) ? Math.max(0, Math.min(100, v / max * 100)) : 0;
        return <button key={mode} type="button" className="profile-arena-bar" data-mode={mode} aria-pressed={selected === mode}
          aria-label={`${t("arena.mode." + mode)}: ${number(v, metric === "kd_ratio" ? 2 : 1)}${metric === "win_rate" ? "%" : ""}${metric === "matches" ? `, ${t("arena.counter.wins")} ${number(counters.wins)}, ${t("arena.counter.losses")} ${number(counters.losses)}` : ""}`}
          aria-keyshortcuts={metric === "matches" ? "ArrowLeft ArrowRight Escape" : undefined}
          onClick={() => onSelect(mode)} onFocus={(event) => { if (metric === "matches") show(mode, "wins", event); }} onBlur={() => setActive(null)}
          onKeyDown={(event) => { if (event.key === "Escape") setActive(null); if (metric === "matches" && (event.key === "ArrowLeft" || event.key === "ArrowRight")) { event.preventDefault(); show(mode, event.key === "ArrowLeft" ? "wins" : "losses", event); } }}>
          <span className="profile-arena-bar__name">{t("arena.mode." + mode)}</span>
          <span className="profile-arena-bar__track" aria-hidden="true"><span className="profile-arena-bar__fill" style={{ width: `${width}%` }}>
            {metric === "matches" ? (["wins", "losses"] as const).map((outcome) => <i key={outcome} data-outcome={outcome} style={{ width: `${counters.matches && counters[outcome] != null ? Math.max(0, Math.min(100, counters[outcome] / counters.matches * 100)) : 0}%` }} onPointerEnter={(event) => show(mode, outcome, event)} onPointerMove={(event) => show(mode, outcome, event)} onClick={(event) => { event.stopPropagation(); show(mode, outcome, event); }} />) : <i style={{ width: "100%" }} />}
          </span></span>
          <strong>{number(v, metric === "kd_ratio" ? 2 : metric === "win_rate" ? 1 : 0)}{v != null && metric === "win_rate" ? "%" : ""}</strong>
        </button>;
      })}
      {active && <div ref={tipRef} className="profile-chart-tooltip profile-arena-tooltip" role="status"><div><span>{t("arena.counter." + active.outcome)}</span><b>{number(profile.modes[active.mode].counters[active.outcome])}</b></div></div>}
    </div>
    {metric === "matches" && <div className="profile-chart-legend profile-arena-bar-legend"><span><i className="is-wins" aria-hidden="true" />{t("arena.counter.wins")}</span><span><i className="is-losses" aria-hidden="true" />{t("arena.counter.losses")}</span></div>}
  </section>;
}
