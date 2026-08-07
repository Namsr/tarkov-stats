"use client";

import Image from "next/image";
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
      <nav className="home-socials" aria-label={t("home.socialLinks")}>
        <a
          className="home-socials__link"
          href={PROJECT_LINKS.twitch}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t("home.social.twitch")}
        >
          <Image
            className="home-socials__icon"
            src="/social/twitch.svg"
            alt=""
            width={28}
            height={28}
          />
        </a>
        <a
          className="home-socials__link"
          href={PROJECT_LINKS.discord}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t("home.social.discord")}
        >
          <Image
            className="home-socials__icon"
            src="/social/discord.svg"
            alt=""
            width={28}
            height={28}
          />
        </a>
        <a
          className="home-socials__link home-socials__link--github"
          href={PROJECT_LINKS.github}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t("home.social.github")}
        >
          <Image
            className="home-socials__icon"
            src="/social/github.svg"
            alt=""
            width={28}
            height={28}
          />
        </a>
      </nav>
    </main>
  );
}
