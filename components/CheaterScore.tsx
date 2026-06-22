"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { ParsedPlayerStats } from "@/types/tarkov";
import { rangeForHours } from "@/lib/playtime-brackets";
import {
  scoreCheater,
  type Baseline,
  type RiskTier,
  type CheaterScoreResult,
} from "@/lib/cheater-score";

const TIER_COLOR: Record<RiskTier, string> = {
  low: "#4caf50",
  medium: "#e0a82e",
  high: "#e07b39",
  severe: "#ef5350",
};

// Colored arc bands. Endpoints precomputed for a semicircle r=120, centre (160,160),
// with tier cuts at score 20 / 45 / 70 (see tierFor in lib/cheater-score.ts).
const ARCS: { d: string; color: string }[] = [
  { d: "M40,160 A120,120 0 0,1 62.9,89.5", color: TIER_COLOR.low },
  { d: "M62.9,89.5 A120,120 0 0,1 141.2,41.5", color: TIER_COLOR.medium },
  { d: "M141.2,41.5 A120,120 0 0,1 230.5,62.9", color: TIER_COLOR.high },
  { d: "M230.5,62.9 A120,120 0 0,1 280,160", color: TIER_COLOR.severe },
];

// Needle tip for a 0–100 score: angle 180°(left)→0°(right), length 96 from centre.
function needle(score: number): { x: number; y: number } {
  const s = Math.min(100, Math.max(0, score));
  const rad = ((180 - (s / 100) * 180) * Math.PI) / 180;
  return { x: 160 + 96 * Math.cos(rad), y: 160 - 96 * Math.sin(rad) };
}

export default function CheaterScore({ stats }: { stats: ParsedPlayerStats }) {
  const { t } = useI18n();
  const [result, setResult] = useState<CheaterScoreResult | null>(null);
  const [loading, setLoading] = useState(true);

  const bracket = rangeForHours(stats.hoursPlayed);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    params.set("minHours", String(bracket.min));
    if (bracket.max != null) params.set("maxHours", String(bracket.max));

    fetch(`/api/baseline?${params.toString()}`)
      .then((r) => (r.ok ? (r.json() as Promise<Baseline>) : null))
      .then((baseline) => {
        if (!cancelled) setResult(scoreCheater(stats, baseline));
      })
      .catch(() => {
        // No baseline → still show the absolute-floor score.
        if (!cancelled) setResult(scoreCheater(stats, null));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [stats, bracket.min, bracket.max]);

  if (loading || !result) {
    return <div className="h-64 skeleton rounded-lg" />;
  }

  const color = TIER_COLOR[result.tier];
  const tip = needle(result.score);
  const shown = result.factors.filter((f) => f.points >= 1);

  return (
    <div className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-4">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs uppercase tracking-wider text-gray-500">{t("cheater.heading")}</span>
        <span className="text-gray-600 text-xs cursor-help" title={t("cheater.disclaimer")} aria-label={t("cheater.disclaimer")}>
          ⓘ
        </span>
      </div>

      <svg viewBox="0 0 320 170" className="w-full max-w-[240px] mx-auto block" role="img" aria-label={t("cheater.heading")}>
        {ARCS.map((a) => (
          <path key={a.d} d={a.d} fill="none" stroke={a.color} strokeWidth={20} strokeOpacity={0.85} strokeLinecap="round" />
        ))}
        <line x1={160} y1={160} x2={tip.x} y2={tip.y} stroke={color} strokeWidth={6} strokeLinecap="round" />
        <circle cx={160} cy={160} r={11} fill={color} />
        <circle cx={160} cy={160} r={5} style={{ fill: "var(--card-bg)" }} />
        <text x={160} y={130} textAnchor="middle" fontSize={56} fontWeight={700} style={{ fill: "var(--foreground)" }}>
          {result.score}
        </text>
      </svg>

      <div className="text-center mt-1">
        <span
          className="inline-block px-3 py-0.5 rounded text-sm font-bold"
          style={{ color, border: `1px solid ${color}66`, background: `${color}14` }}
        >
          {t("cheater.tier." + result.tier)}
        </span>
        <div className="text-[11px] text-gray-500 mt-1">
          {result.score} {t("cheater.outOf")}
        </div>
      </div>

      {shown.length > 0 && (
        <div className="mt-3 flex flex-wrap justify-center gap-x-3 gap-y-1 text-[11px] text-gray-400">
          {shown.map((f) => (
            <span key={f.key} className="whitespace-nowrap">
              {t("metric." + f.key)}{" "}
              <span className="font-medium tabular-nums" style={{ color }}>+{Math.round(f.points)}</span>
            </span>
          ))}
        </div>
      )}

      <p className="text-[10px] text-gray-600 mt-3 text-center">
        {result.basedOnSample
          ? t("cheater.basedOn", { n: result.sampleN.toLocaleString() })
          : t("cheater.preliminary")}
      </p>
    </div>
  );
}
