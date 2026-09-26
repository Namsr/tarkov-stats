"use client";

import type { CSSProperties } from "react";
import { useI18n } from "@/lib/i18n/context";
import { ARENA_TSR_WEIGHTS, type ArenaTsRating } from "@/lib/arena/ts-rating";
import { ARENA_MODE_KEYS, type ArenaProfile, type ArenaProfileRisk, type ArenaStoredMode } from "@/types/arena";

export function ArenaRing({ value, max, text, unit, label }: {
  value: number | null; max: number; text: string; unit: string; label: string;
}) {
  const radius = 72;
  const circumference = 2 * Math.PI * radius;
  const arc = circumference * 0.75;
  const fraction = value == null ? 0 : Math.max(0, Math.min(1, value / max));
  const angle = (135 + fraction * 270) * Math.PI / 180;
  return <div className="arena-combat-ring" role="img" aria-label={`${label}: ${text} ${unit}`}>
    <svg viewBox="0 0 200 184" aria-hidden="true">
      <circle className="arena-combat-ring__track" cx="100" cy="98" r={radius} fill="none" strokeWidth="10" strokeLinecap="round" strokeDasharray={`${arc} ${circumference}`} transform="rotate(135 100 98)" />
      {value != null && <>
        {fraction > 0 && <circle className="arena-combat-ring__fill" cx="100" cy="98" r={radius} fill="none" strokeWidth="10" strokeLinecap="round" strokeDasharray={`${arc * fraction} ${circumference}`} transform="rotate(135 100 98)" />}
        <circle className="arena-combat-ring__dot" cx={100 + radius * Math.cos(angle)} cy={98 + radius * Math.sin(angle)} r="5" />
      </>}
    </svg>
    <div className="arena-combat-ring__value" aria-hidden="true"><strong>{text}</strong><small>{unit}</small></div>
  </div>;
}

export default function ArenaCombatSummary({ profile, risk, rating, scope, onModeChange }: {
  profile: ArenaProfile; risk: ArenaProfileRisk | null; rating: ArenaTsRating | null;
  scope: ArenaStoredMode; onModeChange: (mode: ArenaStoredMode) => void;
}) {
  const { t, lang } = useI18n();
  const number = (value: number | null | undefined, digits = 0) => value == null ? t("common.notAvailable") : value.toLocaleString(lang, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const stats = scope === "overall" ? profile.overall : profile.modes[scope];
  const riskItem = scope === "overall" ? risk?.overall : risk?.modes.find((item) => item.mode === scope);
  const score = riskItem?.score ?? null;
  const tier = score == null ? null : score < 20 ? "low" : score < 45 ? "medium" : score < 70 ? "high" : "severe";
  const item = scope === "overall" ? rating?.overall : rating?.modes[scope];
  const value = item?.displayReady ? item.rating : null;
  const winRate = stats.metrics.win_rate;
  const modeName = (mode: ArenaStoredMode) => t(mode === "overall" ? "profile.allModes" : "arena.mode." + mode);
  const ratingNote = item?.reason
    ? t("arena.tsr.reason." + item.reason)
    : !item?.displayReady ? t("arena.tsr.minimum")
      : item.provisional ? t("arena.tsr.provisional") : t("arena.tsr.baseline");
  return <section id="arena-overview" className="profile-anchor-section arena-combat-summary" tabIndex={-1} aria-label={t("profile.section.overview")}>
    <div className="arena-combat-scope"><strong>{modeName(scope)}</strong><span>{t("arena.counter.matches")}: {number(stats.counters.matches)}</span></div>
    <div className="arena-combat-gauges">
      <article id="arena-risk" className="arena-combat-card" data-risk-tier={tier ?? "unavailable"}>
        <h2>{t("arena.combat.risk")}</h2>
        <ArenaRing value={score} max={100} text={number(score)} unit={t("arena.combat.outOf100")} label={t("arena.combat.risk")} />
        <strong className="arena-combat-status">{tier ? t("arena.combat.risk." + tier) : t("arena.risk.unavailable")}</strong>
        <p className="arena-combat-note">{t("arena.combat.riskNote")}</p>
      </article>
      <article className="arena-combat-card arena-combat-card--rating" style={{ "--arena-ring-color": "var(--foreground)" } as CSSProperties}>
        <h2>{t("arena.tsr.title")} <span className="arena-combat-beta">{t("arena.tsr.beta")}</span></h2>
        <ArenaRing value={value} max={2} text={number(value, 2)} unit={t("arena.tsr.short")} label={t("arena.tsr.title")} />
        <strong className="arena-combat-status">{t(scope === "overall" ? "arena.tsr.overall" : "arena.tsr.mode")}</strong>
        <p className="arena-combat-note">{rating ? ratingNote : t("arena.tsr.unavailable")}</p>
      </article>
      <article className="arena-combat-card arena-combat-card--wins">
        <h2>{t("arena.metric.win_rate")}</h2>
        <ArenaRing value={winRate} max={100} text={winRate == null ? number(null) : `${number(winRate, 1)}%`} unit={t("arena.counter.wins")} label={t("arena.metric.win_rate")} />
        <strong className="arena-combat-status">{t("arena.counter.wins")}: {number(stats.counters.wins)}</strong>
        <p className="arena-combat-note">{t("arena.counter.losses")}: {number(stats.counters.losses)} · {t("arena.counter.matches")}: {number(stats.counters.matches)}</p>
      </article>
    </div>
    <details className="arena-tsr-details">
      <summary>{t("arena.tsr.explanation")}</summary>
      <p>{t("arena.tsr.method")}</p>
      <div className="arena-tsr-breakdown">
        <dl>{Object.entries(ARENA_TSR_WEIGHTS).map(([metric, weight]) => {
          const contribution = item?.contributions?.[metric as keyof typeof ARENA_TSR_WEIGHTS];
          return <div key={metric}><dt>{t("arena.metric." + metric)} <small>{number(weight * 100)}%</small></dt><dd>{contribution == null ? number(null) : `${contribution >= 0 ? "+" : ""}${number(contribution, 3)}`}</dd></div>;
        })}</dl>
        <div>{ARENA_MODE_KEYS.map((mode) => {
          const modeRating = rating?.modes[mode];
          return <button type="button" key={mode} onClick={() => onModeChange(mode)} aria-pressed={scope === mode} className="arena-tsr-mode">
            <span>{modeName(mode)}{modeRating?.provisional && modeRating.displayReady && <small>{t("arena.tsr.provisional")}</small>}</span>
            <span>{number(modeRating?.matches)} <small>{t("arena.counter.matches")}</small></span>
            <strong>{number(modeRating?.displayReady ? modeRating.rating : null, 2)}</strong>
          </button>;
        })}</div>
      </div>
      <p>{t("arena.tsr.reference", { version: rating?.version ?? "0.1", reference: rating?.referenceVersion ?? "—" })}</p>
    </details>
  </section>;
}
