"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import type { ProgressionRiskPayload } from "@/components/ProgressionPanel";
import type { GameMode } from "@/types/seasonal";
import type { PublicRiskFactor, PublicRiskTier, PublicRiskView } from "@/types/profile-view";
import type { ParsedPlayerStats } from "@/types/tarkov";
import { rangeForHours } from "@/lib/playtime-brackets";
import { scoreCheater, type Baseline, type CheaterScoreResult } from "@/lib/cheater-score";

const TIER_COLOR: Record<PublicRiskTier, string> = {
  low: "#4caf50",
  medium: "#e0a82e",
  high: "#e07b39",
  severe: "#ef5350",
};

const ARCS: { d: string; color: string }[] = [
  { d: "M40,160 A120,120 0 0,1 62.9,89.5", color: TIER_COLOR.low },
  { d: "M62.9,89.5 A120,120 0 0,1 141.2,41.5", color: TIER_COLOR.medium },
  { d: "M141.2,41.5 A120,120 0 0,1 230.5,62.9", color: TIER_COLOR.high },
  { d: "M230.5,62.9 A120,120 0 0,1 280,160", color: TIER_COLOR.severe },
];

function needle(score: number): { x: number; y: number } {
  const safeScore = Math.min(100, Math.max(0, score));
  const radians = ((180 - (safeScore / 100) * 180) * Math.PI) / 180;
  return { x: 160 + 96 * Math.cos(radians), y: 160 - 96 * Math.sin(radians) };
}

function tierFor(score: number): PublicRiskTier {
  if (score < 20) return "low";
  if (score < 45) return "medium";
  if (score < 70) return "high";
  return "severe";
}

function knownTier(value: string | null | undefined, score: number): PublicRiskTier {
  return value === "low" || value === "medium" || value === "high" || value === "severe"
    ? value
    : tierFor(score);
}

type RiskInput = PublicRiskView | ProgressionRiskPayload;

interface LegacyAchievementPayload {
  achievements?: Array<{
    id: string;
    owners: number;
    samplePct: number;
    meanHours: number;
    earlyHours: number;
  }>;
}

interface NormalizedRisk {
  score: number | null;
  tier: PublicRiskTier | null;
  confidence: number | null;
  confidenceTier: "low" | "medium" | "high" | null;
  sampleSize: number | null;
  freshnessAt: number | null;
  factors: PublicRiskFactor[];
  available: boolean;
  partial?: boolean;
}

function isPublicRisk(value: RiskInput): value is PublicRiskView {
  return "score" in value;
}

function normalizeRisk(value: RiskInput | null | undefined): NormalizedRisk | null {
  if (!value) return null;
  if (isPublicRisk(value)) {
    const confidence = value.confidence == null
      ? null
      : value.confidence > 1 ? value.confidence / 100 : value.confidence;
    return {
      score: Number.isFinite(value.score) && value.score != null ? value.score : null,
      tier: value.score == null ? null : knownTier(value.tier, value.score),
      confidence,
      confidenceTier: value.confidenceTier ?? null,
      sampleSize: value.sampleSize ?? value.sampleN ?? null,
      freshnessAt: value.freshnessAt ?? null,
      factors: (value.factors ?? []).map((factor) => typeof factor === "string"
        ? { key: factor, points: null, label: null }
        : {
            ...factor,
            key: factor.key,
            points: factor.points == null ? null : factor.points,
            label: factor.label ?? null,
            available: factor.available,
          }),
      available: value.available !== false && value.availability !== "unavailable" && value.score != null,
      partial: value.availability === "partial",
    };
  }

  const score = Number.isFinite(value.combined) ? value.combined : null;
  const confidence = Number.isFinite(value.confidence?.value) ? value.confidence.value : null;
  return {
    score,
    tier: score == null ? null : tierFor(score),
    confidence,
    confidenceTier: value.confidence?.tier ?? null,
    sampleSize: null,
    freshnessAt: null,
    factors: [
      ...value.staticReasons.map((key) => ({ key, points: null, label: null })),
      ...value.reasons.map((key) => ({ key, points: null, label: null })),
    ],
    available: score != null,
  };
}

export default function CheaterScore({
  risk,
  stats,
  ownedAchievementIds = [],
  mode = "regular",
  cycleId = "persistent",
  statsKnown = true,
  loading = false,
  compact = false,
}: {
  risk?: RiskInput | null;
  /** Kept only for the untouched PVE/Arena renderer during the migration. */
  stats?: ParsedPlayerStats;
  ownedAchievementIds?: string[];
  mode?: GameMode;
  cycleId?: string;
  statsKnown?: boolean;
  loading?: boolean;
  compact?: boolean;
}) {
  const { t, lang } = useI18n();
  const [legacyResult, setLegacyResult] = useState<CheaterScoreResult | null>(null);
  const [legacyLoading, setLegacyLoading] = useState(false);
  const ownedKey = ownedAchievementIds.join(",");

  useEffect(() => {
    if (!stats || mode === "regular") {
      setLegacyResult(null);
      setLegacyLoading(false);
      return;
    }
    let cancelled = false;
    const bracket = rangeForHours(stats.hoursPlayed);
    setLegacyLoading(true);
    const params = new URLSearchParams({
      mode,
      minHours: String(bracket.min),
    });
    if (bracket.max != null) params.set("maxHours", String(bracket.max));
    Promise.all([
      fetch(`/api/baseline?${params}`).then((response) => response.ok ? response.json() as Promise<Baseline> : null).catch(() => null),
      fetch(`/api/average/achievements?mode=${encodeURIComponent(mode)}`)
        .then((response) => response.ok ? response.json() as Promise<LegacyAchievementPayload> : null)
        .catch(() => null),
    ]).then(([baseline, achievementPayload]) => {
      if (cancelled) return;
      const achievements = achievementPayload?.achievements;
      setLegacyResult(scoreCheater(
        stats,
        baseline,
        achievements ? {
          ownedIds: ownedKey ? ownedKey.split(",") : [],
          stats: achievements,
        } : null,
      ));
    }).finally(() => {
      if (!cancelled) setLegacyLoading(false);
    });
    return () => { cancelled = true; };
  }, [mode, ownedKey, stats]);

  const legacyRisk: PublicRiskView | null = legacyResult ? {
    score: legacyResult.score,
    tier: legacyResult.tier,
    confidence: Math.min(1, legacyResult.sampleN / 30),
    sampleSize: legacyResult.sampleN,
    freshnessAt: stats?.profileUpdatedAt ?? null,
    factors: legacyResult.factors.map((factor) => ({
      key: factor.key,
      points: factor.points,
      available: factor.available,
    })),
    available: true,
  } : null;
  const normalized = normalizeRisk(risk ?? legacyRisk);
  const modeLabel = t("fav.mode." + mode);

  if (loading || legacyLoading) {
    return <div className="data-panel min-h-[280px] skeleton rounded-xl" role="status" aria-label={t("common.loading")} />;
  }

  if (statsKnown === false && !normalized?.available) {
    return (
      <div className="data-panel min-h-[280px] p-5">
        <p className="text-sm text-[var(--muted)]">{t("cheater.incompletePvp")}</p>
        <p className="mt-3 text-xs text-[var(--muted)]">
          {t("cheater.context", { mode: modeLabel, cycle: cycleId })}
        </p>
        <p className="mt-4 text-xs leading-relaxed text-[var(--muted)]">{t("cheater.disclaimer")}</p>
      </div>
    );
  }

  if (!normalized?.available || normalized.score == null) {
    if (compact) return <p className="home-empty" role="status">{t("cheater.serverUnavailable")}</p>;
    return (
      <div className="data-panel min-h-[280px] p-5">
        <p className="text-sm text-[var(--muted)]">{t("cheater.serverUnavailable")}</p>
        <p className="mt-3 text-xs text-[var(--muted)]">
          {t("cheater.context", { mode: modeLabel, cycle: cycleId })}
        </p>
        <p className="mt-4 text-xs leading-relaxed text-[var(--muted)]">{t("cheater.disclaimer")}</p>
      </div>
    );
  }

  const score = Math.round(Math.min(100, Math.max(0, normalized.score)));
  const tier = normalized.tier ?? tierFor(score);
  const color = TIER_COLOR[tier];
  const tip = needle(score);
  const confidencePercent = normalized.confidence == null ? null : Math.round(normalized.confidence * 100);
  const freshness = normalized.freshnessAt == null
    ? null
    : new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Moscow" })
        .format(normalized.freshnessAt);

  return (
    <div className={compact ? "home-risk-reading" : "data-panel min-h-[280px] p-5"}>
      <svg viewBox={compact ? "0 0 320 230" : "0 0 320 170"} className={compact ? "home-risk-gauge" : "w-full max-w-[240px] mx-auto block"} role="img" aria-label={compact ? t("home.riskGauge", { score, tier: t("cheater.tier." + tier) }) : t("cheater.heading")}>
        {ARCS.map((arc) => (
          <path key={arc.d} d={arc.d} fill="none" stroke={arc.color} strokeWidth={20} strokeOpacity={0.85} strokeLinecap="round" />
        ))}
        <line x1={160} y1={160} x2={tip.x} y2={tip.y} stroke={color} strokeWidth={6} strokeLinecap="round" />
        <circle cx={160} cy={160} r={11} fill={color} />
        <circle cx={160} cy={160} r={5} style={{ fill: "var(--card-bg)" }} />
        <text x={160} y={compact ? 222 : 130} textAnchor="middle" fontSize={56} fontWeight={700} style={{ fill: "var(--foreground)" }}>
          {score}
        </text>
        {compact && <g fill="var(--muted)" fontSize={13} textAnchor="middle"><text x={39} y={188}>0</text><text x={280} y={188}>100</text></g>}
      </svg>

      {compact ? <p className={`home-risk-status home-risk-status--${tier}`}>{t("cheater.tier." + tier)}</p> : <>
      <div className="mt-1 text-center">
        <span className="inline-block px-3 py-0.5 rounded text-sm font-bold" style={{ color, border: `1px solid ${color}66`, background: `${color}14` }}>
          {t("cheater.tier." + tier)}
        </span>
        <div className="mt-1 text-[11px] text-gray-500">{score} {t("cheater.outOf")}</div>
      </div>

      <div className="mt-3 flex flex-wrap justify-center gap-x-3 gap-y-1 text-xs text-[var(--muted)]">
        <span>{t("cheater.context", { mode: modeLabel, cycle: cycleId })}</span>
        {normalized.sampleSize != null && normalized.sampleSize > 0 && <span>{t("cheater.sample", { n: normalized.sampleSize.toLocaleString(lang) })}</span>}
        {normalized.sampleSize != null && normalized.sampleSize > 0 && confidencePercent != null && <span>{t(mode === "regular" ? "cheater.evidenceCoverage" : "seasonal.confidenceValue", { n: confidencePercent })}</span>}
        {freshness && <span>{t("cheater.freshness", { date: freshness })}</span>}
      </div>

      {normalized.factors.length > 0 && (
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          {normalized.factors.map((factor, index) => (
            <span key={`${factor.key}-${index}`} className="seasonal-risk__reason">
              {factor.available === false
                ? t("cheater.factorUnavailable")
                : <>{factor.label ?? t("metric." + factor.key)}{factor.points == null ? "" : ` +${Math.round(factor.points)}`}</>}
            </span>
          ))}
        </div>
      )}

      <p className="mt-3 text-[10px] text-gray-600 text-center">{t("cheater.disclaimer")}</p>
      </>}
      {mode === "regular" && normalized.partial && <p className="mt-3 text-xs leading-relaxed text-[var(--muted)]">{t("cheater.partial")}</p>}
      {mode === "regular" && <details className="mt-4 text-left text-xs leading-relaxed text-[var(--muted)]">
        <summary className="cursor-pointer rounded px-1 py-2 font-medium text-[var(--foreground)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">{t("cheater.whatMoved")}</summary>
        <p className="mt-2">{t("cheater.statisticalScale")}</p>
        {confidencePercent != null && <p className="mt-2">{t("cheater.evidenceCoverage", { n: confidencePercent })}</p>}
        {normalized.factors[0]?.hoursMultiplier != null && <p className="mt-2">{t("cheater.hoursBoost", { n: normalized.factors[0].hoursMultiplier.toFixed(2) })}</p>}
        <ul className="mt-3 space-y-3">
          {normalized.factors.map((factor, index) => {
            const name = factor.achievementId === "6514143d59647d2cb3213c93" ? t("cheater.ultra")
              : factor.achievementId === "664f1f8768508d74604bf556" || factor.achievementId === "6a60f75f1a1222ee000baf0d" ? t("cheater.kappa")
              : factor.label ?? t("metric." + factor.key);
            return <li key={`${factor.key}-${index}`}>
              <p className="font-medium text-[var(--foreground)]">{name}{factor.available !== false && factor.points != null ? ` +${factor.points.toLocaleString(lang, { maximumFractionDigits: 1 })}` : ""}</p>
              {factor.available === false ? <p>{t(factor.reason === "missing_metric" ? "cheater.missingMetric" : factor.reason === "insufficient_owners" ? "cheater.fewOwners" : "cheater.fewPeers")}</p> : <>
                {factor.cohortMean != null && <p>{t(factor.achievementId ? "cheater.ownerComparison" : "cheater.reference", { value: (factor.value ?? 0).toLocaleString(lang, { maximumFractionDigits: 2 }), mean: factor.cohortMean.toLocaleString(lang, { maximumFractionDigits: 2 }), n: factor.cohortN ?? 0 })}</p>}
                {factor.ratio != null && !factor.achievementId && <p>{t("cheater.ratio", { n: factor.ratio.toFixed(2) })}</p>}
                {factor.p90 != null && factor.p99 != null && <p>{t("cheater.tail", { p90: factor.p90.toLocaleString(lang, { maximumFractionDigits: 2 }), p99: factor.p99.toLocaleString(lang, { maximumFractionDigits: 2 }) })}</p>}
                {factor.cohortPercent != null && <p>{t("cheater.window", { n: factor.cohortPercent })}</p>}
                {factor.ownerHoursP20 != null && <p>{t("cheater.ownerP20", { n: factor.ownerHoursP20.toLocaleString(lang, { maximumFractionDigits: 1 }) })}</p>}
                {factor.achievementId && <p>{t("cheater.ownerReference")}</p>}
                {factor.evidencePoints != null && factor.evidencePoints > 0 && factor.points === 0 && <p>{t("cheater.correlated")}</p>}
                {factor.key === "compound_anomaly" && <p>{t("cheater.corroboration")}</p>}
              </>}
            </li>;
          })}
        </ul>
      </details>}
    </div>
  );
}
