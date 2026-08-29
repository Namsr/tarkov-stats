"use client";

import { useI18n } from "@/lib/i18n/context";
import type {
  ArenaModeKey,
  ArenaModeRisk,
  ArenaProfileRisk,
  ArenaRiskMetric,
  ArenaRiskTier,
} from "@/types/arena";

const RISK_METRICS = ["kd_ratio", "win_rate", "kills_per_match", "damage_per_match"] as const;

const TIER_COLOR: Record<ArenaRiskTier, string> = {
  low: "#4caf50",
  medium: "#e0a82e",
  high: "#e07b39",
  severe: "#ef5350",
};

const ARCS = [
  { d: "M40,160 A120,120 0 0,1 62.9,89.5", color: TIER_COLOR.low },
  { d: "M62.9,89.5 A120,120 0 0,1 141.2,41.5", color: TIER_COLOR.medium },
  { d: "M141.2,41.5 A120,120 0 0,1 230.5,62.9", color: TIER_COLOR.high },
  { d: "M230.5,62.9 A120,120 0 0,1 280,160", color: TIER_COLOR.severe },
];

type RiskScope = "overall" | ArenaModeKey;
type RiskItem = Pick<ArenaModeRisk, "score" | "peerCount" | "reasons" | "metrics">;

function needle(score: number): { x: number; y: number } {
  const safeScore = Math.min(100, Math.max(0, score));
  const radians = ((180 - (safeScore / 100) * 180) * Math.PI) / 180;
  return { x: 160 + 96 * Math.cos(radians), y: 160 - 96 * Math.sin(radians) };
}

function tierFor(score: number): ArenaRiskTier {
  if (score < 20) return "low";
  if (score < 45) return "medium";
  if (score < 70) return "high";
  return "severe";
}

function overallRisk(risk: ArenaProfileRisk | null): RiskItem | null {
  return (risk as (ArenaProfileRisk & { overall?: RiskItem | null }) | null)?.overall ?? null;
}

function scopedRisk(risk: ArenaProfileRisk | null, scope: RiskScope): RiskItem | null {
  if (!risk) return null;
  if (scope === "overall") return overallRisk(risk);
  return risk.modes.find((item) => item.mode === scope) ?? null;
}

function reasonLabel(reason: ArenaRiskMetric["reason"], t: (key: string) => string): string {
  if (reason === "missing_metric") return t("arena.risk.reasonMissingMetric");
  if (reason === "insufficient_peers") return t("arena.risk.reasonInsufficientPeers");
  if (reason === "zero_std") return t("arena.risk.reasonZeroSpread");
  return t("arena.risk.reasonObserved");
}

export default function ArenaRiskPanel({
  risk,
  scope,
}: {
  risk: ArenaProfileRisk | null;
  scope: RiskScope;
}) {
  const { lang, t } = useI18n();
  const item = scopedRisk(risk, scope);
  const available = item?.score != null && Number.isFinite(item.score);
  const score = available ? Math.round(Math.min(100, Math.max(0, item.score as number))) : null;
  const tier = score == null ? null : tierFor(score);
  const color = tier ? TIER_COLOR[tier] : "var(--muted)";
  const tip = needle(score ?? 0);
  const evaluatedAt = risk?.freshness.evaluatedAt ?? null;
  const evaluated = evaluatedAt && evaluatedAt > 0
    ? new Intl.DateTimeFormat(lang === "ru" ? "ru-RU" : "en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(evaluatedAt)
    : null;

  return (
    <div className="data-panel h-full min-h-[360px] p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="section-kicker">{t("arena.risk.kicker")}</p>
          <h2 className="section-heading mt-1">
            {scope === "overall" ? t("arena.risk.overallHeading") : t("arena.risk.modeHeading", { mode: t("arena.mode." + scope) })}
          </h2>
        </div>
        {evaluated && <span className="text-xs text-[var(--muted)]">{t("arena.risk.evaluated", { date: evaluated })}</span>}
      </div>

      {score == null || !item ? (
        <div className="mt-6 rounded-xl border border-[var(--card-border)] bg-[var(--input-bg)] p-4" role="status">
          <p className="text-sm text-[var(--muted-strong)]">{t("arena.risk.unavailable")}</p>
          {item && <p className="mt-2 text-xs text-[var(--muted)]">{t("arena.risk.peerSample", { n: item.peerCount.toLocaleString(lang) })}</p>}
        </div>
      ) : (
        <div>
          <svg viewBox="0 0 320 170" className="mx-auto mt-3 block w-full max-w-[240px]" role="img" aria-label={t("arena.risk.gaugeLabel", { n: score })}>
            {ARCS.map((arc) => (
              <path key={arc.d} d={arc.d} fill="none" stroke={arc.color} strokeWidth="20" strokeOpacity="0.85" strokeLinecap="round" />
            ))}
            <line x1="160" y1="160" x2={tip.x} y2={tip.y} stroke={color} strokeWidth="6" strokeLinecap="round" />
            <circle cx="160" cy="160" r="11" fill={color} />
            <circle cx="160" cy="160" r="5" style={{ fill: "var(--card-bg)" }} />
            <text x="160" y="130" textAnchor="middle" fontSize="56" fontWeight="700" style={{ fill: "var(--foreground)" }}>{score}</text>
          </svg>

          <div className="text-center">
            <span className="inline-block rounded px-3 py-0.5 text-sm font-bold" style={{ color, border: `1px solid ${color}66`, background: `${color}14` }}>
              {t("arena.risk.tier." + tier)}
            </span>
            <p className="mt-2 text-xs text-[var(--muted)]">{t("arena.risk.peerSample", { n: item.peerCount.toLocaleString(lang) })}</p>
          </div>
        </div>
      )}

      {item && (
        <div className="mt-4 grid gap-2" aria-label={t("arena.risk.factors")}>
          {RISK_METRICS.map((metric) => {
            const factor = item.metrics[metric];
            const points = factor?.points == null ? null : Math.round(factor.points);
            return (
              <div key={metric} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg bg-[var(--input-bg)] px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold text-[var(--muted-strong)]">{t("arena.metric." + metric)}</p>
                  <p className="mt-0.5 text-[10px] text-[var(--muted)]">
                    {factor?.available
                      ? t("arena.risk.factorDeviation", { n: factor.z == null ? t("common.notAvailable") : factor.z.toLocaleString(lang, { maximumFractionDigits: 2 }) })
                      : reasonLabel(factor?.reason ?? "missing_metric", t)}
                  </p>
                </div>
                <span className="tabular-nums text-sm font-bold text-[var(--foreground)]">
                  {points == null ? t("common.notAvailable") : `+${points}`}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <p className="mt-4 text-center text-[10px] leading-relaxed text-[var(--muted)]">{t("arena.risk.disclaimer")}</p>
    </div>
  );
}
