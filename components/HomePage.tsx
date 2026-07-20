"use client";

import AuthErrorBanner from "@/components/AuthErrorBanner";
import CommunityHelper from "@/components/CommunityHelper";
import SearchBar from "@/components/SearchBar";
import { useI18n } from "@/lib/i18n/context";

export default function HomePage({
  seasonalHelperEnabled,
  reviewEnabled,
}: {
  seasonalHelperEnabled: boolean;
  reviewEnabled: boolean;
}) {
  const { t } = useI18n();
  return (
    <main className="home-hero">
      <div className="home-command">
        <AuthErrorBanner />
        <p className="page-kicker">{t("home.subtitle")}</p>
        <h1 className="home-command__title">TARKOV <span>STATS</span></h1>
        <p className="home-command__description">{t("home.description")}</p>
        <SearchBar autoFocus />
        {(seasonalHelperEnabled || reviewEnabled) && <CommunityHelper seasonalEnabled={seasonalHelperEnabled} reviewEnabled={reviewEnabled} />}
      </div>
    </main>
  );
}
