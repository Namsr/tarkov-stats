"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import ProfileHeader from "@/components/ProfileHeader";
import ProfileModeSwitch from "@/components/ProfileModeSwitch";
import ProfileSectionNav from "@/components/ProfileSectionNav";
import { useI18n } from "@/lib/i18n/context";
import type { GameMode } from "@/types/seasonal";
import type { ProfileShellMode, ProfileViewMetric } from "@/types/profile-view";
import "@/components/profile.css";

const SECTION_IDS = ["overview", "progression", "risk", "comparison", "statistics", "achievements", "mastering", "skills"] as const;
const LEGACY_SECTION_IDS = ["overview", "progression", "risk", "comparison", "statistics", "skills"] as const;

export function ProfileSlotPlaceholder({ className = "min-h-44" }: { className?: string }) {
  return <div className={`data-panel ${className} skeleton rounded-xl`} aria-hidden="true" />;
}

export function ProfileShellLoading({ mode, aid, title }: { mode: GameMode; aid?: number; title?: string }) {
  const { t } = useI18n();
  const sectionIds = mode === "regular" || mode === "pve" || mode === "seasonal"
    ? SECTION_IDS
    : LEGACY_SECTION_IDS;
  return (
    <main className="page-frame profile-page" data-profile-shell-mode={mode}>
      <div className="mb-8 h-5 w-20 skeleton rounded" />
      <ProfileSectionNav
        label={t("profile.sectionNav")}
        items={sectionIds.map((id) => ({ id, label: t("profile.section." + id) }))}
      />
      <section id="overview" tabIndex={-1} className="profile-header surface profile-anchor-section">
        <div className="profile-header__top">
          <div className="profile-header__identity">
            <div className="page-kicker">{aid == null ? <span className="inline-block h-4 w-24 skeleton rounded" /> : `#${aid}`}</div>
            {title ? <h1 className="page-title break-words">{title}</h1> : <div className="mt-3 h-10 w-56 skeleton rounded" />}
          </div>
          <div className="profile-header__controls">
            <div className="profile-header__actions">
              <div className="h-12 w-full max-w-[520px] skeleton rounded" />
            </div>
            <div className="profile-header__mode">
              {aid == null ? (
                <div className="h-10 w-full max-w-[220px] skeleton rounded" aria-hidden="true" />
              ) : (
                <ProfileModeSwitch current={mode} page="player" aid={aid} />
              )}
            </div>
          </div>
        </div>
        <div className="detail-grid mt-7">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="metric-card h-24 skeleton rounded-lg" />
          ))}
        </div>
      </section>
      <div className="mt-5 space-y-5">
        <ProfileShellLoadingSection id="progression" height="min-h-[320px]" />
        <ProfileShellLoadingSection id="risk" height="min-h-[280px]" />
        <ProfileShellLoadingSection id="comparison" height="min-h-[560px]" />
        <ProfileShellLoadingSection id="statistics" height="min-h-[360px]" />
        {(mode === "regular" || mode === "pve" || mode === "seasonal") && (
          <ProfileShellLoadingSection id="achievements" height="min-h-[360px]" />
        )}
        {(mode === "regular" || mode === "pve" || mode === "seasonal") && (
          <ProfileShellLoadingSection id="mastering" height="min-h-[240px]" />
        )}
        <ProfileShellLoadingSection id="skills" height="min-h-[240px]" />
      </div>
    </main>
  );
}

function ProfileShellLoadingSection({ id, height }: { id: string; height: string }) {
  return <section id={id} tabIndex={-1} className="profile-anchor-section"><ProfileSlotPlaceholder className={height} /></section>;
}

export default function ProfileShell({
  aid,
  mode,
  cycleId,
  kicker,
  title,
  leaderboardRevision,
  meta,
  actions,
  activity,
  overviewCards,
  progression,
  risk,
  comparison,
  statistics,
  achievements,
  mastering,
  skills,
  statusNotice,
}: {
  aid: number;
  mode: ProfileShellMode;
  cycleId: string;
  kicker: string;
  title?: string;
  leaderboardRevision?: string | number | null;
  meta?: ReactNode;
  actions: ReactNode;
  activity?: ReactNode;
  overviewCards: readonly ProfileViewMetric[];
  progression: ReactNode;
  risk: ReactNode;
  comparison: ReactNode;
  statistics: ReactNode;
  achievements?: ReactNode;
  mastering?: ReactNode;
  skills?: ReactNode;
  statusNotice?: ReactNode;
}) {
  const { t } = useI18n();
  const baseSectionIds = achievements === undefined
    ? LEGACY_SECTION_IDS
    : SECTION_IDS;
  const sectionIds = baseSectionIds.filter((id) =>
    (id !== "mastering" || mastering !== undefined) && (id !== "skills" || skills !== undefined),
  );
  const sectionLinks = sectionIds.map((id) => ({
    id,
    label: t("profile.section." + id),
  }));

  return (
    <main className="page-frame profile-page" data-profile-shell-mode={mode} data-profile-cycle={cycleId}>
      <Link
        href="/"
        className="profile-back"
      >
        {t("common.back")}
      </Link>

      <ProfileHeader
        aid={aid}
        mode={mode}
        seasonalCycleId={mode === "seasonal" ? cycleId : undefined}
        kicker={kicker}
        title={title}
        leaderboardRevision={leaderboardRevision}
        meta={meta}
        actions={actions}
        activity={activity}
      >
        <ProfileSectionNav label={t("profile.sectionNav")} items={sectionLinks.filter((item) => item.id !== "overview")} />
        <div className="profile-metrics">
          {overviewCards.map((item) => (
            <dl key={item.label} className="profile-metric">
              <dt>{item.label}</dt>
              <dd>{item.value}{item.suffix && <span>{item.suffix}</span>}</dd>
            </dl>
          ))}
        </div>
      </ProfileHeader>

      {statusNotice}

      <div className="profile-content">
        <ProfileShellSection id="progression">{progression}</ProfileShellSection>
        <div className="profile-analysis">
          <ProfileShellSection id="risk">{risk}</ProfileShellSection>
          <ProfileShellSection id="comparison">{comparison}</ProfileShellSection>
        </div>
        <ProfileShellSection id="statistics">{statistics}</ProfileShellSection>
        {achievements !== undefined && <ProfileShellSection id="achievements">{achievements}</ProfileShellSection>}
        {mastering !== undefined && <ProfileShellSection id="mastering">{mastering}</ProfileShellSection>}
        {skills !== undefined && <ProfileShellSection id="skills">{skills}</ProfileShellSection>}
      </div>
    </main>
  );
}

function ProfileShellSection({ id, children }: { id: string; children: ReactNode }) {
  return (
    <section id={id} tabIndex={-1} className="profile-anchor-section min-h-44">
      {children}
    </section>
  );
}
