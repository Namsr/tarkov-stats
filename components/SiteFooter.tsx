"use client";

import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import { PROJECT_LINKS } from "@/lib/support";

export default function SiteFooter() {
  const { t } = useI18n();

  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <p>
          Tarkov Stats — {t("footer.independent")}{" "}
          <Link href="/about">Namsr</Link>
        </p>
        <nav aria-label={t("footer.navigation")}>
          <Link href="/about">{t("nav.about")}</Link>
          <Link href="/support">{t("nav.support")}</Link>
          <Link href="/community">{t("nav.community")}</Link>
          <a href={PROJECT_LINKS.github} target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
          <a href={PROJECT_LINKS.discord} target="_blank" rel="noopener noreferrer">
            Discord
          </a>
        </nav>
      </div>
    </footer>
  );
}
