"use client";

import AuthErrorBanner from "@/components/AuthErrorBanner";
import SearchBar from "@/components/SearchBar";
import { useI18n } from "@/lib/i18n/context";
import { PROJECT_LINKS } from "@/lib/support";

export default function HomePage() {
  const { t } = useI18n();
  return (
    <main className="home-hero">
      <div className="home-command">
        <AuthErrorBanner />
        <p className="page-kicker">{t("home.subtitle")}</p>
        <h1 className="home-command__title">TARKOV <span>STATS</span></h1>
        <p className="home-command__description">{t("home.description")}</p>
        <SearchBar autoFocus />
      </div>
      <p className="home-command__owner">
        {t("home.independent")}{" "}
        <a href={PROJECT_LINKS.twitch} target="_blank" rel="noopener noreferrer">
          Namsr
        </a>
      </p>
    </main>
  );
}
