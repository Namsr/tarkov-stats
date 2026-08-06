"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import ProgressionTimelineChart from "@/components/ProgressionTimelineChart";
import StatCard from "@/components/StatCard";
import FavoriteButton from "@/components/FavoriteButton";
import CheaterReportButton from "@/components/CheaterReportButton";
import RefreshButton from "@/components/RefreshButton";
import ProfileHeader from "@/components/ProfileHeader";
import ProfileSectionNav from "@/components/ProfileSectionNav";
import { useI18n } from "@/lib/i18n/context";
import { levelAtExperience, type LevelBand } from "@/lib/seasonal/ui";
import type {
  ProgressionTimelineResponse,
  SeasonalProfile,
} from "@/types/seasonal";
import type { ProgressionRiskMarker } from "@/lib/seasonal/progression-details";

interface RiskPayload {
  combined: number;
  static: number | null;
  progression: number | null;
  confidence: { value: number; tier: "low" | "medium" | "high" };
  staticContribution: number;
  progressionContribution: number;
  staticReasons: string[];
  reasons: string[];
  markers: ProgressionRiskMarker[];
}

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
  const [timeline, setTimeline] = useState<ProgressionTimelineResponse | null>(null);
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

  useEffect(() => {
    const controller = new AbortController();
    setProgressionLoading(true);
    setProgressionError("");
    setTimeline(null);
    const params = new URLSearchParams({ mode: "seasonal", cycle: cycleId, aid: String(aid) });
    fetch(`/api/progression/timeline?${params}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(t("seasonal.progressionUnavailable"));
        return (await response.json()) as ProgressionTimelineResponse;
      })
      .then(setTimeline)
      .catch((caught: unknown) => {
        if (caught instanceof Error && caught.name === "AbortError") return;
        setTimeline(null);
        setProgressionError(t("seasonal.progressionUnavailable"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setProgressionLoading(false);
      });
    return () => controller.abort();
  }, [aid, cycleId, t]);

  const risk = useMemo(() => {
    const candidate = timeline?.risk;
    return validRisk(candidate) ? candidate : null;
  }, [timeline]);
  const longTerm = timeline?.longTerm;
  const history = timeline?.history;

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
  return (
    <main className="page-frame">
      <Link href="/" className="text-sm text-[var(--muted)] hover:text-[var(--foreground)]">{t("common.back")}</Link>
      <ProfileSectionNav
        label={t("profile.sectionNav")}
        items={[
          { id: "overview", label: t("profile.section.overview") },
          { id: "progression", label: t("profile.section.progression") },
          { id: "risk", label: t("profile.section.risk") },
          { id: "statistics", label: t("profile.section.statistics") },
        ]}
      />
      <ProfileHeader
        aid={aid}
        mode="seasonal"
        kicker={t("seasonal.profileKicker", { cycle: cycleId, aid })}
        title={profile.nickname}
        meta={
          <div className="profile-header__meta">
            <span>{t("seasonal.lastUpdated")}: {new Date(profile.profileUpdatedAt).toLocaleDateString(undefined, { timeZone: "Europe/Moscow" })}</span>
          </div>
        }
        actions={
          <div className="profile-actions-grid">
              <RefreshButton aid={aid} mode="seasonal" />
              <FavoriteButton
                aid={aid}
                nickname={profile.nickname}
                identity={{ mode: "seasonal", cycleId }}
              />
              <CheaterReportButton aid={aid} mode="seasonal" cycle={cycleId} />
          </div>
        }
      >
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
      </ProfileHeader>

      <div id="progression" tabIndex={-1} className="profile-anchor-section seasonal-controls">
        {progressionLoading && <span className="text-sm text-[var(--muted)]">{t("common.loading")}</span>}
      </div>

      {progressionError && <p className="mt-5 text-sm text-[var(--muted)]">{progressionError}</p>}
      {timeline && <ProgressionTimelineChart data={timeline} title={t("progression.timeline.title")} />}

      {history && (
        <div className="seasonal-chart__meta mt-4">
          <span>{t(history.ready ? "progression.ready" : "progression.collecting")}</span>
          <span>{t("progression.baselineSnapshot", { n: history.snapshotCount > 0 ? 1 : 0 })}</span>
          <span>{t("progression.snapshots", { n: history.snapshotCount })}</span>
          <span>{t("progression.intervals", { n: history.intervalCount })}</span>
          <span>{t("progression.allIntervals", { n: history.allIntervalCount })}</span>
          <span>{t("progression.changedIntervals", { n: history.changedIntervalCount })}</span>
          <span>{t("progression.raidIntervals", { n: history.raidIntervalCount })}</span>
          <span>{t("progression.tempoPoints", { n: history.tempoPointCount })}</span>
          <span>{t("progression.formPoints", { n: history.formPointCount })}</span>
          {history.firstObservedAt && (
            <span>{t("progression.firstObserved", { date: new Date(history.firstObservedAt).toLocaleString(undefined, { timeZone: "Europe/Moscow" }) })}</span>
          )}
          {history.lastObservedAt && (
            <span>{t("progression.lastObserved", { date: new Date(history.lastObservedAt).toLocaleString(undefined, { timeZone: "Europe/Moscow" }) })}</span>
          )}
        </div>
      )}

      <section id="risk" tabIndex={-1} className="profile-anchor-section seasonal-risk data-panel">
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
              {risk.reasons.filter((reason) => reason !== "pmc_raids_per_day").map((reason) => (
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

      <section id="statistics" tabIndex={-1} className="profile-anchor-section mt-5">
        <h2 className="section-heading mb-3">{t("seasonal.longTerm")}</h2>
        <div className="data-ledger">
          <StatCard label={t("seasonal.metric.survival")} value={number(longTerm?.survivalRate)} suffix="%" />
          <StatCard label={t("seasonal.metric.pvpKd")} value={number(longTerm?.pvpKd)} />
          <StatCard label={t("seasonal.metric.aiKd")} value={number(longTerm?.aiKd)} />
          <StatCard label={t("seasonal.metric.overallPmcKd")} value={number(longTerm?.overallPmcKd)} />
          <StatCard label={t("seasonal.metric.intervals")} value={longTerm?.intervals ?? history?.intervalCount ?? "—"} />
          <StatCard label={t("seasonal.metric.coveredRaids")} value={longTerm?.coveredRaids ?? "—"} />
        </div>
      </section>
    </main>
  );
}
