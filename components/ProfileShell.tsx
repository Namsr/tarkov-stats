"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import ProfileHeader from "@/components/ProfileHeader";
import ProfileModeSwitch from "@/components/ProfileModeSwitch";
import ProfileSectionNav from "@/components/ProfileSectionNav";
import { useI18n } from "@/lib/i18n/context";
import type { GameMode } from "@/types/seasonal";
import type { ProfileShellMode, ProfileViewMetric } from "@/types/profile-view";

const SECTION_IDS = ["overview", "progression", "risk", "comparison", "statistics", "achievements", "skills"] as const;
const LEGACY_SECTION_IDS = ["overview", "progression", "risk", "comparison", "statistics", "skills"] as const;

export function ProfileSlotPlaceholder({ className = "min-h-44" }: { className?: string }) {
  return <div className={`data-panel ${className} skeleton rounded-xl`} aria-hidden="true" />;
}

export function ProfileShellLoading({ mode, aid, title }: { mode: GameMode; aid?: number; title?: string }) {
  const { t } = useI18n();
  const sectionIds = mode === "regular" || mode === "seasonal" ? SECTION_IDS : LEGACY_SECTION_IDS;
  return (
    <main className="page-frame" data-profile-shell-mode={mode}>
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
        {(mode === "regular" || mode === "seasonal") && (
          <ProfileShellLoadingSection id="achievements" height="min-h-[360px]" />
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
  meta,
  actions,
  overviewCards,
  progression,
  risk,
  comparison,
  statistics,
  achievements,
  skills,
  statusNotice,
}: {
  aid: number;
  mode: ProfileShellMode;
  cycleId: string;
  kicker: string;
  title?: string;
  meta?: ReactNode;
  actions: ReactNode;
  overviewCards: readonly ProfileViewMetric[];
  progression: ReactNode;
  risk: ReactNode;
  comparison: ReactNode;
  statistics: ReactNode;
  achievements?: ReactNode;
  skills?: ReactNode;
  statusNotice?: ReactNode;
}) {
  const { t } = useI18n();
  const baseSectionIds = achievements === undefined
    ? LEGACY_SECTION_IDS
    : SECTION_IDS;
  const sectionIds = skills === undefined
    ? baseSectionIds.filter((id) => id !== "skills")
    : baseSectionIds;
  const sectionLinks = sectionIds.map((id) => ({
    id,
    label: t("profile.section." + id),
  }));

  return (
    <main className="page-frame" data-profile-shell-mode={mode} data-profile-cycle={cycleId}>
      <Link
        href="/"
        className="text-sm text-[var(--muted)] hover:text-[var(--foreground)] transition-colors mb-8 inline-block"
      >
        {t("common.back")}
      </Link>

      <ProfileSectionNav label={t("profile.sectionNav")} items={sectionLinks} />

      <ProfileHeader
        aid={aid}
        mode={mode}
        seasonalCycleId={mode === "seasonal" ? cycleId : undefined}
        kicker={kicker}
        title={title}
        meta={meta}
        actions={actions}
      >
        <div className="detail-grid mt-7">
          {overviewCards.map((item) => (
            <div key={item.label} className="min-h-24">
              <div className="h-full">
                <div className="metric-card flex flex-col gap-2 h-full">
                  <span className="metric-card__label">{item.label}</span>
                  <div className="flex items-end gap-2">
                    <span className="metric-card__value">
                      {item.value}
                      {item.suffix && <span className="metric-card__suffix ml-1">{item.suffix}</span>}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </ProfileHeader>

      {statusNotice}

      <div className="mt-5 space-y-5">
        <ProfileShellSection id="progression">{progression}</ProfileShellSection>
        <ProfileShellSection id="risk">{risk}</ProfileShellSection>
        <ProfileShellSection id="comparison">{comparison}</ProfileShellSection>
        <ProfileShellSection id="statistics">{statistics}</ProfileShellSection>
        {achievements !== undefined && <ProfileShellSection id="achievements">{achievements}</ProfileShellSection>}
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
