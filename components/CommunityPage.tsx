"use client";

import Link from "next/link";
import CommunityHelper from "@/components/CommunityHelper";
import { useI18n } from "@/lib/i18n/context";
import { PROJECT_LINKS } from "@/lib/support";

export default function CommunityPage({
  helperEnabled,
  reviewEnabled,
}: {
  helperEnabled: boolean;
  reviewEnabled: boolean;
}) {
  const { t } = useI18n();
  const enabled = helperEnabled || reviewEnabled;

  return (
    <main className="page-frame project-page">
      <header className="project-page__hero">
        <p className="page-kicker">{t("community.kicker")}</p>
        <h1 className="page-title">{t("community.title")}</h1>
        <p className="project-page__lead">{t("community.intro")}</p>
      </header>

      {enabled ? (
        <CommunityHelper
          seasonalEnabled={helperEnabled}
          reviewEnabled={reviewEnabled}
          defaultExpanded
        />
      ) : (
        <section className="coming-soon data-panel">
          <span className="coming-soon__status">{t("community.soon")}</span>
          <h2 className="section-heading">{t("community.soonTitle")}</h2>
          <p>{t("community.soonDescription")}</p>
        </section>
      )}

      <section className="community-links data-panel" aria-labelledby="community-links">
        <div>
          <p className="section-kicker">{t("community.linksKicker")}</p>
          <h2 id="community-links" className="section-heading">
            {t("community.linksTitle")}
          </h2>
          <p>{t("community.linksDescription")}</p>
        </div>
        <div className="project-cta__actions">
          <a
            className="tactical-button"
            href={PROJECT_LINKS.discord}
            target="_blank"
            rel="noopener noreferrer"
          >
            Discord
          </a>
          <a
            className="ghost-button"
            href={PROJECT_LINKS.github}
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub
          </a>
          <Link className="ghost-button" href="/support">
            {t("nav.support")}
          </Link>
        </div>
      </section>
    </main>
  );
}
