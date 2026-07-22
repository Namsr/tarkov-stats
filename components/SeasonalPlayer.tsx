"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import SeasonalProgressionChart, { type RiskMarker } from "@/components/SeasonalProgressionChart";
import StatCard from "@/components/StatCard";
import FavoriteButton from "@/components/FavoriteButton";
import CheaterReportButton from "@/components/CheaterReportButton";
import RefreshButton from "@/components/RefreshButton";
import ProfileModeSwitch from "@/components/ProfileModeSwitch";
import { useI18n } from "@/lib/i18n/context";
import { levelAtExperience, xpPerDay, type LevelBand } from "@/lib/seasonal/ui";
import type {
  CohortDimension,
  ProgressionKind,
  ProgressionSeriesResponse,
  SeasonalProfile,
} from "@/types/seasonal";

interface RiskPayload {
  combined: number;
  static: number | null;
  progression: number | null;
  confidence: { value: number; tier: "low" | "medium" | "high" };
  staticContribution: number;
  progressionContribution: number;
  staticReasons: string[];
  reasons: string[];
  markers: RiskMarker[];
}

interface LongTermPayload {
  xpPerDay: number | null;
  raidsPerDay: number | null;
  pmcKillsPerDay: number | null;
  pmcKillsPerRaid: number | null;
  nonPmcKillsPerDay: number | null;
  nonPmcKillsPerRaid: number | null;
  survivalRate: number | null;
  pvpKd: number | null;
  aiKd: number | null;
  overallPmcKd: number | null;
  intervals: number;
  coveredRaids: number;
}

type ExtendedProgression = ProgressionSeriesResponse & {
  risk?: RiskPayload;
  longTerm?: LongTermPayload;
};

function number(value: number | null | undefined, digits = 1): string {
  return value == null || !Number.isFinite(value)
    ? "—"
    : value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function validRisk(value: unknown): value is RiskPayload {
  if (!value || typeof value !== "object") return false;
  const risk = value as Partial<RiskPayload>;
  return Number.isFinite(risk.combined) &&
    (risk.static === null || Number.isFinite(risk.static)) &&
    (risk.progression === null || Number.isFinite(risk.progression)) &&
    Boolean(risk.confidence && Number.isFinite(risk.confidence.value)) &&
    Array.isArray(risk.staticReasons) && Array.isArray(risk.reasons) && Array.isArray(risk.markers);
}

function riskTier(score: number) {
  if (score < 20) return "low";
  if (score < 45) return "medium";
  if (score < 70) return "high";
  return "severe";
}

const REASONS = new Set([
  "pmc_kills_per_raid",
  "pvp_kd",
  "survival_rate",
  "xp_per_pmc_raid",
  "all_kills_per_pmc_raid",
  "pmc_raids_per_day",
]);

export default function SeasonalPlayer({
  aid,
  cycleId,
  levelBands,
}: {
  aid: number;
  cycleId: string;
  levelBands: LevelBand[];
}) {
  const { t } = useI18n();
  const [profile, setProfile] = useState<SeasonalProfile | null>(null);
  const [dimension, setDimension] = useState<CohortDimension>("hours");
  const [series, setSeries] = useState<Partial<Record<ProgressionKind, ExtendedProgression>>>({});
  const [loading, setLoading] = useState(true);
  const [progressionLoading, setProgressionLoading] = useState(false);
  const [error, setError] = useState("");
  const [progressionError, setProgressionError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ aid: String(aid), mode: "seasonal", cycle: cycleId });
    fetch(`/api/player/profile?${params}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json()) as { profile?: SeasonalProfile; error?: string };
        if (!response.ok || !body.profile) throw new Error(t("seasonal.profileUnavailable"));
        return body.profile;
      })
      .then(setProfile)
      .catch((caught: unknown) => {
        if (caught instanceof Error && caught.name === "AbortError") return;
        setError(caught instanceof Error ? caught.message : t("seasonal.profileUnavailable"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [aid, cycleId, t]);

  const center = profile
    ? dimension === "hours"
      ? profile.lifetimePvpHours ?? 0
      : profile.counters.pmcRaids
    : null;

  useEffect(() => {
    if (center == null) return;
    const controller = new AbortController();
    setProgressionLoading(true);
    setProgressionError("");
    Promise.all(
      (["cumulative", "tempo", "form"] as const).map(async (kind) => {
        const params = new URLSearchParams({
          cycle: cycleId,
          aid: String(aid),
          kind,
          dimension,
          center: String(center),
        });
        const response = await fetch(`/api/seasonal/progression?${params}`, { signal: controller.signal });
        if (!response.ok) throw new Error(t("seasonal.progressionUnavailable"));
        return [kind, (await response.json()) as ExtendedProgression] as const;
      }),
    )
      .then((entries) => setSeries(Object.fromEntries(entries)))
      .catch((caught: unknown) => {
        if (caught instanceof Error && caught.name === "AbortError") return;
        setSeries({});
        setProgressionError(t("seasonal.progressionUnavailable"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setProgressionLoading(false);
      });
    return () => controller.abort();
  }, [aid, center, cycleId, dimension, t]);

  const risk = useMemo(() => {
    const candidate = series.tempo?.risk ?? series.form?.risk ?? series.cumulative?.risk;
    return validRisk(candidate) ? candidate : null;
  }, [series]);
  const longTerm = series.tempo?.longTerm ?? series.form?.longTerm ?? series.cumulative?.longTerm;
  const markers = risk?.markers ?? [];

  if (loading) {
    return (
      <main className="page-frame space-y-5">
        <div className="h-36 rounded-xl skeleton" />
        <div className="h-80 rounded-xl skeleton" />
      </main>
    );
  }
  if (!profile || error) {
    return (
      <main className="page-frame">
        <p className="text-[var(--danger)]">{error || t("seasonal.profileUnavailable")}</p>
        <Link href="/" className="mt-4 inline-block text-[var(--accent)] hover:underline">{t("common.back")}</Link>
      </main>
    );
  }

  const level = levelAtExperience(profile.counters.experience, levelBands);
  const survival = profile.counters.pmcRaids > 0
    ? (profile.counters.pmcSurvived / profile.counters.pmcRaids) * 100
    : 0;
  const localXpPerDay = series.cumulative ? xpPerDay(series.cumulative.player) : null;

  return (
    <main className="page-frame">
      <Link href="/" className="text-sm text-[var(--muted)] hover:text-[var(--foreground)]">{t("common.back")}</Link>
      <section className="surface mt-7 p-5 sm:p-7">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <p className="page-kicker">{t("seasonal.profileKicker", { cycle: cycleId, aid })}</p>
            <h1 className="page-title break-words">{profile.nickname}</h1>
          </div>
          <div className="flex flex-wrap items-start gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <RefreshButton aid={aid} mode="seasonal" />
              <FavoriteButton
                aid={aid}
                nickname={profile.nickname}
                identity={{ mode: "seasonal", cycleId }}
              />
              <CheaterReportButton aid={aid} mode="seasonal" cycle={cycleId} />
            </div>
            <ProfileModeSwitch current="seasonal" page="player" aid={aid} />
          </div>
        </div>
        <div className="detail-grid mt-7">
          <StatCard label={t("player.experience")} value={profile.counters.experience.toLocaleString()} />
          <StatCard label={t("player.level")} value={level || "—"} />
          <StatCard label={t("player.pmcRaids")} value={profile.counters.pmcRaids.toLocaleString()} />
          <StatCard label={t("player.pmcKills")} value={profile.counters.killedPmc.toLocaleString()} />
          <StatCard label={t("seasonal.pmcSurvival")} value={number(survival)} suffix="%" />
          <StatCard label={t("player.scavRaids")} value={profile.counters.scavRaids.toLocaleString()} />
          <StatCard label={t("player.hoursPlayed")} value={number(profile.lifetimePvpHours)} suffix={t("unit.h")} />
          <StatCard label={t("seasonal.lastUpdated")} value={new Date(profile.profileUpdatedAt).toLocaleDateString(undefined, { timeZone: "Europe/Moscow" })} />
        </div>
      </section>

      <div className="seasonal-controls">
        <div>
          <span className="section-kicker">{t("seasonal.compareBy")}</span>
          <div className="seasonal-segmented">
            {(["hours", "pmc_raids"] as const).map((value) => (
              <button type="button" key={value} onClick={() => setDimension(value)} aria-pressed={dimension === value} className={dimension === value ? "is-active" : ""}>
                {t(value === "hours" ? "average.dimensionHours" : "average.dimensionPmcRaids")}
              </button>
            ))}
          </div>
        </div>
        {progressionLoading && <span className="text-sm text-[var(--muted)]">{t("common.loading")}</span>}
      </div>

      {progressionError && <p className="mt-5 text-sm text-[var(--muted)]">{progressionError}</p>}
      {series.cumulative && (
        <SeasonalProgressionChart data={series.cumulative} title={t("seasonal.chart.xp")} levelBands={levelBands} />
      )}
      {series.tempo && (
        <SeasonalProgressionChart data={series.tempo} title={t("seasonal.chart.tempo")} riskMarkers={markers} />
      )}
      {series.form && (
        <SeasonalProgressionChart data={series.form} title={t("seasonal.chart.form")} riskMarkers={markers} />
      )}

      <section className="seasonal-risk data-panel">
        <div>
          <p className="section-kicker">{t("seasonal.risk.kicker")}</p>
          <h2 className="section-heading">{t("cheater.heading")}</h2>
        </div>
        {risk ? (
          <>
            <div className="seasonal-risk__scores">
              <StatCard label={t("seasonal.risk.combined")} value={Math.round(risk.combined)} suffix="/100" />
              <StatCard label={t("seasonal.risk.static")} value={risk.static == null ? "—" : Math.round(risk.static)} />
              <StatCard label={t("seasonal.risk.progression")} value={risk.progression == null ? "—" : Math.round(risk.progression)} />
              <StatCard label={t("seasonal.risk.confidence")} value={t("seasonal.confidence." + risk.confidence.tier)} suffix={`${Math.round(risk.confidence.value * 100)}%`} />
            </div>
            <p className="mt-4 text-sm text-[var(--muted)]">
              {t("seasonal.risk.contributions", {
                static: number(risk.staticContribution),
                progression: number(risk.progressionContribution),
              })}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {risk.staticReasons.map((reason) => (
                <span key={`static-${reason}`} className="seasonal-risk__reason">
                  {t("seasonal.risk.static")}: {t("metric." + reason)}
                </span>
              ))}
              {risk.reasons.map((reason) => (
                <span key={reason} className="seasonal-risk__reason">
                  {t("seasonal.riskReason." + (REASONS.has(reason) ? reason : "anomaly"))}
                </span>
              ))}
              <span className="seasonal-risk__tier">{t("cheater.tier." + riskTier(risk.combined))}</span>
            </div>
          </>
        ) : (
          <p className="mt-4 text-sm text-[var(--muted)]">{t("seasonal.risk.unavailable")}</p>
        )}
        <p className="mt-4 text-xs leading-relaxed text-[var(--muted)]">{t("cheater.disclaimer")} {t("seasonal.risk.noAutoExclusion")}</p>
      </section>

      <section className="mt-5">
        <h2 className="section-heading mb-3">{t("seasonal.longTerm")}</h2>
        <div className="data-ledger">
          <StatCard label={t("seasonal.metric.xpPerDay")} value={number(longTerm?.xpPerDay ?? localXpPerDay, 0)} />
          <StatCard label={t("seasonal.metric.raidsPerDay")} value={number(longTerm?.raidsPerDay)} />
          <StatCard label={t("seasonal.metric.pmcKillsPerDay")} value={number(longTerm?.pmcKillsPerDay)} />
          <StatCard label={t("seasonal.metric.pmcKillsPerRaid")} value={number(longTerm?.pmcKillsPerRaid)} />
          <StatCard label={t("seasonal.metric.nonPmcKillsPerDay")} value={number(longTerm?.nonPmcKillsPerDay)} />
          <StatCard label={t("seasonal.metric.nonPmcKillsPerRaid")} value={number(longTerm?.nonPmcKillsPerRaid)} />
          <StatCard label={t("seasonal.metric.survival")} value={number(longTerm?.survivalRate)} suffix="%" />
          <StatCard label={t("seasonal.metric.pvpKd")} value={number(longTerm?.pvpKd)} />
          <StatCard label={t("seasonal.metric.aiKd")} value={number(longTerm?.aiKd)} />
          <StatCard label={t("seasonal.metric.overallPmcKd")} value={number(longTerm?.overallPmcKd)} />
          <StatCard label={t("seasonal.metric.intervals")} value={longTerm?.intervals ?? series.tempo?.player.length ?? "—"} />
          <StatCard label={t("seasonal.metric.coveredRaids")} value={longTerm?.coveredRaids ?? "—"} />
        </div>
      </section>
    </main>
  );
}
